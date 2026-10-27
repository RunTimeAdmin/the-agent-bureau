import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const db = vi.hoisted(() => ({
  addPlayQuestion: vi.fn(),
  claimQuestion: vi.fn(),
  createPlay: vi.fn(),
  finishPlay: vi.fn(),
  getPlay: vi.fn(),
  listPlayQuestions: vi.fn(),
  refundQuestion: vi.fn(),
}));
const { askSuspect } = vi.hoisted(() => ({ askSuspect: vi.fn() }));

vi.mock("./db", () => db);
vi.mock("./interrogate", () => ({ askSuspect }));

import { suspectIds } from "@shared/case001";
import { CASE_001_MOLE, suspectPrompt } from "./cases/case001";
import { appRouter, resetInquiryRateLimiter } from "./routers";

const PLAY_ID = "0123456789abcdef0123456789abcdef";

function createContext(ip = "198.51.100.20"): TrpcContext {
  return {
    isOperator: false,
    req: { ip, headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function openPlay(overrides = {}) {
  return {
    id: PLAY_ID,
    caseId: "001",
    questionsUsed: 2,
    accused: null,
    solved: null,
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  };
}

const turns = [
  { id: 1, playId: PLAY_ID, suspect: "moth", question: "Q1", answer: "A1" },
  { id: 2, playId: PLAY_ID, suspect: "vane", question: "Q2", answer: "A2" },
];

afterEach(() => {
  for (const mock of [...Object.values(db), askSuspect]) mock.mockReset();
  resetInquiryRateLimiter();
});

describe("play.start", () => {
  it("creates a game with an unguessable id", async () => {
    const caller = appRouter.createCaller(createContext());
    const { playId } = await caller.play.start();
    expect(playId).toMatch(/^[0-9a-f]{32}$/);
    expect(db.createPlay).toHaveBeenCalledWith(playId, "001");
  });
});

describe("play.get", () => {
  it("keeps the answer server-side until the accusation", async () => {
    db.getPlay.mockResolvedValue(openPlay());
    db.listPlayQuestions.mockResolvedValue(turns);
    const caller = appRouter.createCaller(createContext());
    const state = await caller.play.get({ playId: PLAY_ID });
    expect(state.verdict).toBeNull();
    expect(state.turns).toHaveLength(2);
    expect(JSON.stringify(state)).not.toMatch(/mole|solution/i);
  });

  it("rejects ids that are not 32 hex characters", async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.play.get({ playId: "../../etc/passwd" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.getPlay).not.toHaveBeenCalled();
  });

  it("reports a missing game as not found", async () => {
    db.getPlay.mockResolvedValue(undefined);
    const caller = appRouter.createCaller(createContext());
    await expect(caller.play.get({ playId: PLAY_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("play.ask", () => {
  it("sends only that suspect's earlier questions and stores the answer", async () => {
    db.getPlay.mockResolvedValue(openPlay());
    db.claimQuestion.mockResolvedValue(true);
    db.listPlayQuestions.mockResolvedValue(turns);
    askSuspect.mockResolvedValue("I was home by 23:15.");
    const caller = appRouter.createCaller(createContext());

    const result = await caller.play.ask({
      playId: PLAY_ID,
      suspect: "vane",
      question: "  Where were you at 23:30?  ",
    });

    expect(result).toEqual({ answer: "I was home by 23:15." });
    expect(db.claimQuestion).toHaveBeenCalledWith(PLAY_ID, 12);
    expect(askSuspect).toHaveBeenCalledWith(
      suspectPrompt("vane"),
      [turns[1]],
      "Where were you at 23:30?"
    );
    expect(db.addPlayQuestion).toHaveBeenCalledWith({
      playId: PLAY_ID,
      suspect: "vane",
      question: "Where were you at 23:30?",
      answer: "I was home by 23:15.",
    });
    expect(db.refundQuestion).not.toHaveBeenCalled();
  });

  it("stops at the question limit without calling the model", async () => {
    db.getPlay.mockResolvedValue(openPlay({ questionsUsed: 12 }));
    db.claimQuestion.mockResolvedValue(false);
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.play.ask({ playId: PLAY_ID, suspect: "moth", question: "Why?" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(askSuspect).not.toHaveBeenCalled();
  });

  it("refunds the question when the model call fails or declines", async () => {
    db.getPlay.mockResolvedValue(openPlay());
    db.claimQuestion.mockResolvedValue(true);
    db.listPlayQuestions.mockResolvedValue([]);
    const caller = appRouter.createCaller(createContext());
    const ask = () =>
      caller.play.ask({
        playId: PLAY_ID,
        suspect: "heron",
        question: "Where?",
      });

    askSuspect.mockRejectedValueOnce(new Error("network down"));
    await expect(ask()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    askSuspect.mockResolvedValueOnce(null);
    await expect(ask()).rejects.toMatchObject({
      code: "UNPROCESSABLE_CONTENT",
    });

    expect(db.refundQuestion).toHaveBeenCalledTimes(2);
    expect(db.addPlayQuestion).not.toHaveBeenCalled();
  });

  it("rejects empty and overlong questions", async () => {
    const caller = appRouter.createCaller(createContext());
    for (const question of ["  ", "x".repeat(281)]) {
      await expect(
        caller.play.ask({ playId: PLAY_ID, suspect: "lynx", question })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(db.claimQuestion).not.toHaveBeenCalled();
  });
});

describe("play.accuse", () => {
  it("records the accusation and reveals the answer", async () => {
    db.getPlay
      .mockResolvedValueOnce(openPlay())
      .mockResolvedValueOnce(
        openPlay({ accused: "kestrel", solved: false, finishedAt: new Date() })
      );
    db.listPlayQuestions.mockResolvedValue([]);
    const caller = appRouter.createCaller(createContext());

    const state = await caller.play.accuse({
      playId: PLAY_ID,
      suspect: "kestrel",
    });

    expect(db.finishPlay).toHaveBeenCalledWith(PLAY_ID, "kestrel", false);
    expect(state.verdict).toMatchObject({
      accused: "kestrel",
      solved: false,
      mole: "vane",
    });
    expect(state.verdict?.solution.length).toBeGreaterThan(0);
  });

  it("marks the right accusation as solved", async () => {
    db.getPlay.mockResolvedValue(openPlay());
    db.listPlayQuestions.mockResolvedValue([]);
    const caller = appRouter.createCaller(createContext());
    await caller.play.accuse({ playId: PLAY_ID, suspect: CASE_001_MOLE });
    expect(db.finishPlay).toHaveBeenCalledWith(PLAY_ID, CASE_001_MOLE, true);
  });
});

describe("suspect prompts", () => {
  it("tell only the mole that they are the mole", () => {
    for (const suspect of suspectIds) {
      expect(suspectPrompt(suspect).includes("You are also the mole")).toBe(
        suspect === CASE_001_MOLE
      );
    }
  });
});
