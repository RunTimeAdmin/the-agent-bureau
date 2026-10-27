import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const db = vi.hoisted(() => ({
  addPlayQuestion: vi.fn(),
  claimQuestion: vi.fn(),
  countAgentUsageSince: vi.fn(),
  countAgentsSince: vi.fn(),
  countQuestionsSince: vi.fn(),
  createAgent: vi.fn(),
  createPlay: vi.fn(),
  finishPlay: vi.fn(),
  getAgentByKeyHash: vi.fn(),
  getPlay: vi.fn(),
  listPlayQuestions: vi.fn(),
  refundQuestion: vi.fn(),
}));
const { askSuspect } = vi.hoisted(() => ({ askSuspect: vi.fn() }));

vi.mock("./db", () => db);
vi.mock("./interrogate", () => ({ askSuspect, isOutOfCredit: () => false }));

import {
  AGENT_LIMITS,
  createAgentApi,
  hashKey,
  resetAgentRateLimiter,
} from "./agentApi";

const KEY = "bur_test-key-0123456789abcdefghij";
const GAME_ID = "0123456789abcdef0123456789abcdef";
const AGENT = {
  id: 7,
  name: "Sleuth-9",
  builder: "acme",
  keyHash: hashKey(KEY),
  hidden: false,
  createdAt: new Date(),
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/agent/v1", createAgentApi());
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/v1`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  db.getAgentByKeyHash.mockImplementation(async (hash: string) =>
    hash === AGENT.keyHash ? AGENT : undefined
  );
  db.countAgentUsageSince.mockResolvedValue({ games: 0, questions: 0 });
  db.countAgentsSince.mockResolvedValue(0);
  db.countQuestionsSince.mockResolvedValue(0);
  db.listPlayQuestions.mockResolvedValue([]);
});

afterEach(() => {
  for (const mock of [...Object.values(db), askSuspect]) mock.mockReset();
  resetAgentRateLimiter();
});

function call(path: string, init: RequestInit & { key?: string | null } = {}) {
  const { key = KEY, ...rest } = init;
  return fetch(`${base}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...rest.headers,
    },
  });
}

function agentPlay(overrides = {}) {
  return {
    id: GAME_ID,
    caseId: "001",
    agentId: AGENT.id,
    questionsUsed: 3,
    accused: null,
    solved: null,
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  };
}

describe("registering an agent", () => {
  it("returns a key once and stores only its hash", async () => {
    const res = await call("/agents", {
      method: "POST",
      key: null,
      body: JSON.stringify({ name: "Sleuth-9", builder: "acme" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.apiKey).toMatch(/^bur_[A-Za-z0-9_-]{32}$/);
    expect(db.createAgent).toHaveBeenCalledWith({
      name: "Sleuth-9",
      builder: "acme",
      keyHash: hashKey(body.apiKey),
    });
    expect(JSON.stringify(db.createAgent.mock.calls)).not.toContain(
      body.apiKey
    );
  });

  it("rejects names that could carry markup or junk", async () => {
    for (const name of ["<b>x</b>", "a", "x".repeat(41), "-dash-"]) {
      const res = await call("/agents", {
        method: "POST",
        key: null,
        body: JSON.stringify({ name, builder: "acme" }),
      });
      expect(res.status).toBe(400);
    }
    expect(db.createAgent).not.toHaveBeenCalled();
  });

  it("refuses a taken name with 409", async () => {
    db.createAgent.mockRejectedValue(
      new Error("insert failed", {
        cause: Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" }),
      })
    );
    const res = await call("/agents", {
      method: "POST",
      key: null,
      body: JSON.stringify({ name: "Sleuth-9", builder: "acme" }),
    });
    expect(res.status).toBe(409);
  });

  it("stops all registrations once the site-wide daily cap is reached", async () => {
    db.countAgentsSince.mockResolvedValue(AGENT_LIMITS.registrationsPerDay);
    const res = await call("/agents", {
      method: "POST",
      key: null,
      body: JSON.stringify({ name: "late-comer", builder: "acme" }),
    });
    expect(res.status).toBe(429);
    expect(db.createAgent).not.toHaveBeenCalled();
  });

  it("allows three registrations per address per day", async () => {
    const register = (name: string) =>
      call("/agents", {
        method: "POST",
        key: null,
        body: JSON.stringify({ name, builder: "acme" }),
      });
    for (const name of ["one-1", "two-2", "three-3"]) {
      expect((await register(name)).status).toBe(201);
    }
    expect((await register("four-4")).status).toBe(429);
  });
});

describe("authentication", () => {
  it("needs a known, active agent key", async () => {
    expect((await call("/games", { method: "POST", key: null })).status).toBe(
      401
    );
    expect(
      (await call("/games", { method: "POST", key: "bur_unknown-key-zzzz" }))
        .status
    ).toBe(401);
    db.getAgentByKeyHash.mockResolvedValue({ ...AGENT, hidden: true });
    expect((await call("/games", { method: "POST" })).status).toBe(403);
    expect(db.createPlay).not.toHaveBeenCalled();
  });
});

describe("playing a case", () => {
  it("starts a game with the public case only", async () => {
    const res = await call("/games", { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.gameId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.case.suspects).toHaveLength(5);
    expect(body.questionsLeft).toBe(12);
    expect(JSON.stringify(body)).not.toMatch(/mole:|gambling|You are/);
    expect(db.createPlay).toHaveBeenCalledWith(body.gameId, "001", AGENT.id);
  });

  it("caps cases and questions per agent per day", async () => {
    db.countAgentUsageSince.mockResolvedValue({
      games: AGENT_LIMITS.gamesPerDay,
      questions: AGENT_LIMITS.questionsPerDay,
    });
    expect((await call("/games", { method: "POST" })).status).toBe(429);
    const ask = await call(`/games/${GAME_ID}/ask`, {
      method: "POST",
      body: JSON.stringify({ suspect: "vane", question: "Where were you?" }),
    });
    expect(ask.status).toBe(429);
    expect(askSuspect).not.toHaveBeenCalled();
  });

  it("closes agent mode once the agents' daily budget is spent", async () => {
    db.countQuestionsSince.mockResolvedValue(500);
    const res = await call("/games", { method: "POST" });
    expect(res.status).toBe(429);
    expect(db.countQuestionsSince).toHaveBeenCalledWith(expect.any(Date), true);
  });

  it("answers a question and reports what's left", async () => {
    db.getPlay.mockResolvedValue(agentPlay());
    db.claimQuestion.mockResolvedValue(true);
    askSuspect.mockResolvedValue("I was home by 23:15.");
    const res = await call(`/games/${GAME_ID}/ask`, {
      method: "POST",
      body: JSON.stringify({ suspect: "vane", question: "Where were you?" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      suspect: "vane",
      answer: "I was home by 23:15.",
      questionsUsed: 4,
      questionsLeft: 8,
    });
  });

  it("shows no verdict or answer before the accusation", async () => {
    db.getPlay.mockResolvedValue(agentPlay());
    const res = await call(`/games/${GAME_ID}`);
    const body = await res.json();
    expect(body.verdict).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/vane|solution|mole/i);
  });

  it("reveals nothing when a question fails or is declined", async () => {
    db.getPlay.mockResolvedValue(agentPlay());
    db.claimQuestion.mockResolvedValue(true);
    const ask = () =>
      call(`/games/${GAME_ID}/ask`, {
        method: "POST",
        body: JSON.stringify({
          suspect: "vane",
          question: "Are you the mole?",
        }),
      });
    askSuspect.mockRejectedValueOnce(new Error("model down"));
    askSuspect.mockResolvedValueOnce(null);
    for (const res of [await ask(), await ask()]) {
      const body = await res.json();
      expect(Object.keys(body)).toEqual(["error"]);
      expect(JSON.stringify(body)).not.toMatch(/vane|solution|answer"/i);
    }
    expect(db.refundQuestion).toHaveBeenCalledTimes(2);
  });

  it("hides other players' games", async () => {
    for (const agentId of [null, 99]) {
      db.getPlay.mockResolvedValue(agentPlay({ agentId }));
      const res = await call(`/games/${GAME_ID}`);
      expect(res.status).toBe(404);
    }
  });

  it("ends with a verdict and a share card naming the agent", async () => {
    db.getPlay
      .mockResolvedValueOnce(agentPlay())
      .mockResolvedValueOnce(
        agentPlay({ accused: "vane", solved: true, finishedAt: new Date() })
      );
    const res = await call(`/games/${GAME_ID}/accuse`, {
      method: "POST",
      body: JSON.stringify({ suspect: "vane" }),
    });
    const body = await res.json();
    expect(body.verdict).toMatchObject({ solved: true, mole: "vane" });
    expect(body.verdict.share.text).toContain("Agent run");
    expect(body.verdict.share.text).toContain("Sleuth-9, built by acme");
    expect(body.verdict.share.url).toMatch(/\/agents$/);
  });
});

describe("protocol", () => {
  it("answers JSON for bad bodies and unknown paths, and allows CORS", async () => {
    const bad = await call(`/games/${GAME_ID}/ask`, {
      method: "POST",
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("BAD_REQUEST");

    const missing = await call("/nowhere");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await fetch(`${base}/games`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });
});
