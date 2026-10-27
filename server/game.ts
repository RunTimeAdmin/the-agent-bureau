import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CASE_001, suspectIds, type SuspectId } from "@shared/case001";
import type { Play, PlayQuestion } from "../drizzle/schema";
import {
  CASE_001_MOLE,
  CASE_001_SOLUTION,
  suspectPrompt,
} from "./cases/case001";
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
export const suspectSchema = z.enum(suspectIds);
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

// A game is visible only to whoever started it: browser games through the
// browser API, and each agent's games through that agent's key.
async function loadPlay(playId: string, player: Player): Promise<Play> {
  const play = await getPlay(playId);
  if (!play || play.caseId !== CASE_001.id || play.agentId !== player.agentId) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That game could not be found.",
    });
  }
  return play;
}

// The answer only leaves the server once the player has made their accusation.
export function gameState(play: Play, questions: PlayQuestion[]) {
  return {
    questionsUsed: play.questionsUsed,
    turns: questions.map(turn => ({
      suspect: turn.suspect as SuspectId,
      question: turn.question,
      answer: turn.answer,
    })),
    verdict: play.finishedAt
      ? {
          accused: play.accused as SuspectId,
          solved: play.solved === true,
          mole: CASE_001_MOLE,
          solution: CASE_001_SOLUTION,
        }
      : null,
  };
}

export type GameState = ReturnType<typeof gameState>;

export async function startGame(player: Player): Promise<string> {
  await assertBureauOpen(player);
  const playId = randomBytes(16).toString("hex");
  await createPlay(playId, CASE_001.id, player.agentId);
  return playId;
}

export async function getGame(
  playId: string,
  player: Player
): Promise<GameState> {
  const play = await loadPlay(playId, player);
  return gameState(play, await listPlayQuestions(play.id));
}

export async function askInGame(
  playId: string,
  player: Player,
  suspect: SuspectId,
  question: string
): Promise<{ answer: string; questionsUsed: number }> {
  await assertBureauOpen(player);
  const play = await loadPlay(playId, player);
  if (!(await claimQuestion(play.id, CASE_001.questionLimit))) {
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
    answer = await askSuspect(suspectPrompt(suspect), history, question);
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

  await addPlayQuestion({ playId: play.id, suspect, question, answer });
  return { answer, questionsUsed: play.questionsUsed + 1 };
}

export async function accuseInGame(
  playId: string,
  player: Player,
  suspect: SuspectId
): Promise<GameState> {
  const play = await loadPlay(playId, player);
  // A second accusation changes nothing: the first one stands.
  await finishPlay(play.id, suspect, suspect === CASE_001_MOLE);
  return getGame(play.id, player);
}
