import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { findCase, LATEST_CASE, type PublicCase } from "@shared/cases";
import type { Play, PlayQuestion } from "../drizzle/schema";
import { privateCase, WITHHELD_REPLY } from "./cases";
import type { PrivateCase } from "./cases/common";
import {
  addPlayQuestion,
  claimQuestion,
  createPlay,
  finishPlay,
  getPlay,
  listPlayQuestions,
  readDaily,
  refundQuestion,
  releaseDaily,
  reserveDaily,
} from "./db";
import { askSuspect, isOutOfCredit } from "./interrogate";

// Game rules shared by the browser game (tRPC) and agent mode (HTTP API).
// Game data stays in the game tables: nothing here reads or writes a Bureau
// file, and nothing from the Bureau becomes a game score.

// Every question is a paid model call. These daily totals cap the bill however
// many addresses or agents there are, and humans and agents have separate
// budgets so agents can't use up the browser game's day.
export const DAILY_QUESTION_LIMIT = { humans: 1500, agents: 500 };
// Per-agent daily caps. Defined here, not in agentApi.ts, so the budget is
// reserved in one place (server/game.ts imports nothing from agentApi.ts).
export const AGENT_QUESTIONS_PER_DAY = 120;
export const AGENT_GAMES_PER_DAY = 10;
export const CLOSED_FOR_TODAY =
  "The Bureau is closed for today. Come back tomorrow.";

export const playIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const caseIdSchema = z
  .string()
  .regex(/^\d{3}$/, "Use a case id like 002");
// Each case has its own suspects, so ids are checked against the game's case.
export const suspectSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,16}$/, "Use a suspect id from the case");
export const questionSchema = z
  .string()
  .trim()
  .min(3, "Ask a full question")
  .max(280, "Keep questions to 280 characters");

/** A person in the browser (agentId null) or a registered agent. */
export type Player = { agentId: number | null };

export function startOfUtcDay(now = new Date()): Date {
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  return midnight;
}

// The budget key for the current UTC day, as YYYY-MM-DD. Built from the date
// alone, so the window does not depend on the database session time zone.
export function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// A question draws on the global budget for its side, and an agent also draws
// on its own per-agent budget. Reserved in list order, so the first that is
// full gives the message. Each entry's scope is a row in daily_usage.
function questionBudgets(
  player: Player
): Array<{ scope: string; limit: number; message: string }> {
  if (player.agentId === null) {
    return [
      { scope: "humans", limit: DAILY_QUESTION_LIMIT.humans, message: CLOSED_FOR_TODAY },
    ];
  }
  return [
    {
      scope: `agent-q:${player.agentId}`,
      limit: AGENT_QUESTIONS_PER_DAY,
      message: `This agent has asked ${AGENT_QUESTIONS_PER_DAY} questions today. Try again after midnight UTC.`,
    },
    { scope: "agents", limit: DAILY_QUESTION_LIMIT.agents, message: CLOSED_FOR_TODAY },
  ];
}

// Reserves one unit from every budget a question draws on, before the paid
// call. Returns the scopes held so they can be released, or throws when any is
// full (after giving back the ones already taken).
async function reserveQuestion(day: string, player: Player): Promise<string[]> {
  const held: string[] = [];
  for (const { scope, limit, message } of questionBudgets(player)) {
    if (await reserveDaily(day, scope, limit)) {
      held.push(scope);
      continue;
    }
    for (const scopeHeld of held) await releaseDaily(day, scopeHeld);
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message });
  }
  return held;
}

type CaseHalves = { publicCase: PublicCase; secret: PrivateCase };

function caseHalves(caseId: string): CaseHalves | undefined {
  const publicCase = findCase(caseId);
  const secret = privateCase(caseId);
  return publicCase && secret ? { publicCase, secret } : undefined;
}

function assertSuspect(publicCase: PublicCase, suspect: string): void {
  if (!publicCase.suspects.some(entry => entry.id === suspect)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `There is no suspect "${suspect}" in Case ${publicCase.id}. Use one of: ${publicCase.suspects.map(entry => entry.id).join(", ")}.`,
    });
  }
}

// A game is visible only to whoever started it: browser games through the
// browser API, and each agent's games through that agent's key.
async function loadPlay(
  playId: string,
  player: Player
): Promise<CaseHalves & { play: Play }> {
  const play = await getPlay(playId);
  const halves = play && caseHalves(play.caseId);
  if (!play || !halves || play.agentId !== player.agentId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That game could not be found.",
    });
  }
  return { play, ...halves };
}

// The answer only leaves the server once the player has made their accusation.
export function gameState(
  play: Play,
  questions: PlayQuestion[],
  secret: PrivateCase
) {
  return {
    caseId: play.caseId,
    questionsUsed: play.questionsUsed,
    turns: questions.map(turn => ({
      suspect: turn.suspect,
      question: turn.question,
      answer: turn.answer,
    })),
    verdict: play.finishedAt
      ? {
          accused: play.accused ?? "",
          solved: play.solved === true,
          mole: secret.mole,
          solution: secret.solution,
        }
      : null,
  };
}

export type GameState = ReturnType<typeof gameState>;

export async function startGame(
  player: Player,
  caseId: string = LATEST_CASE.id
): Promise<string> {
  if (!caseHalves(caseId)) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `There is no case ${caseId}.`,
    });
  }
  const day = utcDayKey();
  // Starting a game makes no model call, so this only refuses new games once
  // the day's question budget is already spent. A read is enough here.
  const globalScope = player.agentId === null ? "humans" : "agents";
  const globalLimit =
    player.agentId === null
      ? DAILY_QUESTION_LIMIT.humans
      : DAILY_QUESTION_LIMIT.agents;
  if ((await readDaily(day, globalScope)) >= globalLimit) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: CLOSED_FOR_TODAY });
  }
  const playId = randomBytes(16).toString("hex");
  if (player.agentId === null) {
    await createPlay(playId, caseId, null);
    return playId;
  }
  // Reserve a game slot atomically so parallel starts cannot exceed the cap.
  if (
    !(await reserveDaily(
      day,
      `agent-games:${player.agentId}`,
      AGENT_GAMES_PER_DAY
    ))
  ) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `This agent has started ${AGENT_GAMES_PER_DAY} cases today. Try again after midnight UTC.`,
    });
  }
  try {
    await createPlay(playId, caseId, player.agentId);
  } catch (error) {
    await releaseDaily(day, `agent-games:${player.agentId}`);
    throw error;
  }
  return playId;
}

export async function getGame(
  playId: string,
  player: Player
): Promise<GameState> {
  const { play, secret } = await loadPlay(playId, player);
  return gameState(play, await listPlayQuestions(play.id), secret);
}

export async function askInGame(
  playId: string,
  player: Player,
  suspect: string,
  question: string
): Promise<{ answer: string; questionsUsed: number; questionsLeft: number }> {
  // Check ownership and the suspect first, so a request for a game the caller
  // does not own does no budget work and touches no shared counter.
  const { play, publicCase, secret } = await loadPlay(playId, player);
  assertSuspect(publicCase, suspect);

  // Reserve the daily budget before the paid call. A declined or failed call
  // keeps its reservation, so a budget cannot be drained by inducing refusals.
  const day = utcDayKey();
  const heldBudgets = await reserveQuestion(day, player);

  if (!(await claimQuestion(play.id, publicCase.questionLimit))) {
    // No model call will be made, so give the daily units back.
    for (const scope of heldBudgets) await releaseDaily(day, scope);
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: play.finishedAt
        ? "This case is closed."
        : "You are out of questions. Name the mole.",
    });
  }

  let answer: string | null;
  try {
    const history = (await listPlayQuestions(play.id)).filter(
      turn => turn.suspect === suspect
    );
    answer = await askSuspect(secret.suspectPrompt(suspect), history, question);
  } catch (error) {
    // Give the player's per-game question back, but keep the daily budget unit:
    // a paid call was attempted.
    await refundQuestion(play.id);
    console.error("[Play] Interrogation failed:", error);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: isOutOfCredit(error)
        ? CLOSED_FOR_TODAY
        : "The line went dead. That question was not counted.",
    });
  }
  if (!answer) {
    await refundQuestion(play.id);
    throw new TRPCError({
      code: "UNPROCESSABLE_CONTENT",
      message:
        "The suspect won't answer that. It was not counted, so try asking another way.",
    });
  }

  // The question still counts, so probing for the brief costs the player.
  if (secret.leaksBrief(answer)) {
    console.warn(
      `[Play] Withheld a reply from ${suspect} that quoted its brief`
    );
    answer = WITHHELD_REPLY;
  }

  await addPlayQuestion({ playId: play.id, suspect, question, answer });
  const questionsUsed = play.questionsUsed + 1;
  return {
    answer,
    questionsUsed,
    questionsLeft: Math.max(0, publicCase.questionLimit - questionsUsed),
  };
}

export async function accuseInGame(
  playId: string,
  player: Player,
  suspect: string
): Promise<GameState> {
  const { play, publicCase, secret } = await loadPlay(playId, player);
  assertSuspect(publicCase, suspect);
  // A second accusation changes nothing: the first one stands.
  await finishPlay(play.id, suspect, suspect === secret.mole);
  return getGame(play.id, player);
}
