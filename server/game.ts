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
  countQuestionsSince,
  createPlay,
  finishPlay,
  getPlay,
  listPlayQuestions,
  refundQuestion,
} from "./db";
import { askSuspect, isOutOfCredit } from "./interrogate";

// Game rules shared by the browser game (tRPC) and agent mode (HTTP API).
// Game data stays in the game tables: nothing here reads or writes a Bureau
// file, and nothing from the Bureau becomes a game score.

// Every question is a paid model call. These daily totals cap the bill however
// many addresses or agents there are, and humans and agents have separate
// budgets so agents can't use up the browser game's day.
export const DAILY_QUESTION_LIMIT = { humans: 1500, agents: 500 };
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

async function assertBureauOpen(player: Player): Promise<void> {
  const byAgents = player.agentId !== null;
  const limit = byAgents
    ? DAILY_QUESTION_LIMIT.agents
    : DAILY_QUESTION_LIMIT.humans;
  if ((await countQuestionsSince(startOfUtcDay(), byAgents)) >= limit) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: CLOSED_FOR_TODAY,
    });
  }
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
  await assertBureauOpen(player);
  const playId = randomBytes(16).toString("hex");
  await createPlay(playId, caseId, player.agentId);
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
  await assertBureauOpen(player);
  const { play, publicCase, secret } = await loadPlay(playId, player);
  assertSuspect(publicCase, suspect);
  if (!(await claimQuestion(play.id, publicCase.questionLimit))) {
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
