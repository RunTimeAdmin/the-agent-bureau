import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { z, ZodError } from "zod";
import { CASES, findCase, LATEST_CASE, type PublicCase } from "@shared/cases";
import { shareText } from "@shared/share";
import type { Agent } from "../drizzle/schema";
import {
  createAgent,
  getAgentByKeyHash,
  releaseDaily,
  reserveDaily,
} from "./db";
import {
  accuseInGame,
  AGENT_GAMES_PER_DAY,
  AGENT_QUESTIONS_PER_DAY,
  askInGame,
  caseIdSchema,
  DAILY_QUESTION_LIMIT,
  getGame,
  playIdSchema,
  questionSchema,
  startGame,
  suspectSchema,
  utcDayKey,
  type GameState,
} from "./game";
import { createRateLimiter, getRequestIp } from "./rateLimit";

// Agent mode: a small JSON API so people can point their own AI agent at a
// case. Agents play exactly the game humans play, through server/game.ts, and
// their results stay in the game tables, apart from any Bureau file.

// Registrations are capped per address and, because addresses are cheap,
// site-wide too. The bill is capped by the agents' shared daily question
// budget in server/game.ts, whatever the number of agents.
export const AGENT_LIMITS = {
  gamesPerDay: AGENT_GAMES_PER_DAY,
  questionsPerDay: AGENT_QUESTIONS_PER_DAY,
  registrationsPerAddressPerDay: 3,
  registrationsPerDay: 50,
  allAgentsQuestionsPerDay: DAILY_QUESTION_LIMIT.agents,
};
const KEY_PREFIX = "bur_";
const registerRateLimit = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: AGENT_LIMITS.registrationsPerAddressPerDay,
});
const siteUrl = () =>
  (process.env.PUBLIC_SITE_URL || "https://theagentbureau.xyz").replace(
    /\/+$/,
    ""
  );

// Names appear on the public scoreboard, so keep them plain.
const displayName = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,38}[A-Za-z0-9]$/,
    "Use 3 to 40 letters, numbers, spaces, dots, dashes or underscores, starting and ending with a letter or number"
  );
const registerSchema = z.object({ name: displayName, builder: displayName });
const askSchema = z.object({
  suspect: suspectSchema,
  question: questionSchema,
});
const accuseSchema = z.object({ suspect: suspectSchema });

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Reset only for isolated unit tests; production code never calls this. */
export function resetAgentRateLimiter(): void {
  registerRateLimit.reset();
}

function publicCase(entry: PublicCase) {
  return {
    id: entry.id,
    title: entry.title,
    teaser: entry.teaser,
    brief: entry.brief,
    intercept: entry.intercept,
    orders: entry.orders,
    questionLimit: entry.questionLimit,
    suspects: entry.suspects.map(suspect => ({
      id: suspect.id,
      codename: suspect.codename,
      name: suspect.name,
      role: suspect.role,
      lastNight: suspect.lastNight,
      flagged: suspect.onFile,
    })),
  };
}

function rules(entry: PublicCase) {
  return [
    `You have ${entry.questionLimit} questions to spend across all ${entry.suspects.length} suspects.`,
    "Each suspect remembers only the questions you have asked them.",
    "Suspects are fictional characters played by an AI model. The mole lies; the others hide their own secrets.",
    "You get one accusation. The first one ends the game.",
  ];
}

// Without a case id, agents get the newest case.
function chosenCase(raw: unknown): PublicCase {
  if (raw === undefined || raw === null || raw === "") return LATEST_CASE;
  const entry = findCase(caseIdSchema.parse(raw));
  if (!entry) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `There is no case ${String(raw)}. GET /api/agent/v1/cases lists them.`,
    });
  }
  return entry;
}

function gameBody(gameId: string, state: GameState, agent: Agent) {
  const entry = findCase(state.caseId)!;
  return {
    gameId,
    caseId: state.caseId,
    questionsUsed: state.questionsUsed,
    questionsLeft: Math.max(0, entry.questionLimit - state.questionsUsed),
    turns: state.turns,
    verdict: state.verdict && {
      ...state.verdict,
      share: {
        text: shareText({
          caseId: state.caseId,
          solved: state.verdict.solved,
          used: state.questionsUsed,
          limit: entry.questionLimit,
          url: `${siteUrl()}/agents`,
          agent,
        }),
        url: `${siteUrl()}/agents`,
      },
    },
  };
}

async function requireAgent(req: Request): Promise<Agent> {
  const match = /^Bearer\s+(\S+)$/.exec(req.get("authorization") ?? "");
  if (!match || !match[1].startsWith(KEY_PREFIX)) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Send your agent key as: Authorization: Bearer <key>.",
    });
  }
  const agent = await getAgentByKeyHash(hashKey(match[1]));
  if (!agent) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "That agent key isn't recognised.",
    });
  }
  if (agent.hidden) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This agent has been removed from agent mode.",
    });
  }
  return agent;
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string
) {
  res.status(status).json({ error: { code, message } });
}

function isDuplicateEntry(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: string }).code === "ER_DUP_ENTRY") return true;
  }
  return false;
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch(error => {
      if (error instanceof ZodError) {
        sendError(
          res,
          400,
          "BAD_REQUEST",
          error.issues
            .map(issue => `${issue.path.join(".") || "body"}: ${issue.message}`)
            .join("; ")
        );
      } else if (error instanceof TRPCError) {
        sendError(
          res,
          getHTTPStatusCodeFromError(error),
          error.code,
          error.message
        );
      } else {
        console.error("[Agent API]", error);
        sendError(
          res,
          500,
          "INTERNAL_SERVER_ERROR",
          "Something went wrong. Try again."
        );
      }
    });
  };
}

export function createAgentApi() {
  const api = express.Router();

  // Agents authenticate with a bearer key, never cookies, so any origin may
  // call the API.
  api.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Cache-Control": "no-store",
    });
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  api.use(express.json({ limit: "10kb" }));

  api.get("/", (_req, res) => {
    res.json({
      name: "BUREAU agent API",
      version: "v1",
      docs: `${siteUrl()}/agents`,
      llms: `${siteUrl()}/llms.txt`,
      openapi: `${siteUrl()}/openapi.json`,
      example: `${siteUrl()}/agent-example.py`,
      endpoints: {
        register: "POST /api/agent/v1/agents {name, builder}",
        cases: "GET /api/agent/v1/cases",
        case: "GET /api/agent/v1/case?caseId=002",
        start: "POST /api/agent/v1/games {caseId?}",
        game: "GET /api/agent/v1/games/{gameId}",
        ask: "POST /api/agent/v1/games/{gameId}/ask {suspect, question}",
        accuse: "POST /api/agent/v1/games/{gameId}/accuse {suspect}",
      },
      auth: "Authorization: Bearer <key> on every /games request",
      limits: AGENT_LIMITS,
    });
  });

  api.get("/cases", (_req, res) => {
    res.json({
      latest: LATEST_CASE.id,
      cases: CASES.map(entry => ({
        id: entry.id,
        title: entry.title,
        teaser: entry.teaser,
        questionLimit: entry.questionLimit,
      })),
    });
  });

  api.get(
    "/case",
    handle(async (req, res) => {
      const entry = chosenCase(req.query.caseId);
      res.json({ case: publicCase(entry), rules: rules(entry) });
    })
  );

  api.post(
    "/agents",
    handle(async (req, res) => {
      const input = registerSchema.parse(req.body ?? {});
      if (!registerRateLimit.consume(getRequestIp(req))) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "That's all the agents for this address today.",
        });
      }
      // Reserve the site-wide daily slot atomically so parallel registrations
      // cannot all pass the same count and exceed the cap.
      const day = utcDayKey();
      if (
        !(await reserveDaily(
          day,
          "registrations",
          AGENT_LIMITS.registrationsPerDay
        ))
      ) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message:
            "Agent registration is full for today. Try again after midnight UTC.",
        });
      }
      const apiKey = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
      try {
        await createAgent({ ...input, keyHash: hashKey(apiKey) });
      } catch (error) {
        // A failed insert must not use up the day's registration slot.
        await releaseDaily(day, "registrations");
        if (!isDuplicateEntry(error)) throw error;
        throw new TRPCError({
          code: "CONFLICT",
          message: "That agent name is taken. Pick another.",
        });
      }
      res.status(201).json({
        agent: input,
        apiKey,
        note: "Store this key now. It is shown only once.",
      });
    })
  );

  api.post(
    "/games",
    handle(async (req, res) => {
      const agent = await requireAgent(req);
      const entry = chosenCase((req.body ?? {}).caseId);
      // startGame reserves the per-agent daily game slot atomically.
      const gameId = await startGame({ agentId: agent.id }, entry.id);
      res.status(201).json({
        gameId,
        case: publicCase(entry),
        rules: rules(entry),
        questionsUsed: 0,
        questionsLeft: entry.questionLimit,
      });
    })
  );

  api.get(
    "/games/:gameId",
    handle(async (req, res) => {
      const agent = await requireAgent(req);
      const gameId = playIdSchema.parse(req.params.gameId);
      res.json(
        gameBody(gameId, await getGame(gameId, { agentId: agent.id }), agent)
      );
    })
  );

  api.post(
    "/games/:gameId/ask",
    handle(async (req, res) => {
      const agent = await requireAgent(req);
      const gameId = playIdSchema.parse(req.params.gameId);
      const input = askSchema.parse(req.body ?? {});
      // askInGame reserves the per-agent and shared daily budgets atomically.
      const { answer, questionsUsed, questionsLeft } = await askInGame(
        gameId,
        { agentId: agent.id },
        input.suspect,
        input.question
      );
      res.json({
        suspect: input.suspect,
        answer,
        questionsUsed,
        questionsLeft,
      });
    })
  );

  api.post(
    "/games/:gameId/accuse",
    handle(async (req, res) => {
      const agent = await requireAgent(req);
      const gameId = playIdSchema.parse(req.params.gameId);
      const input = accuseSchema.parse(req.body ?? {});
      const state = await accuseInGame(
        gameId,
        { agentId: agent.id },
        input.suspect
      );
      res.json(gameBody(gameId, state, agent));
    })
  );

  api.use((_req, res) => {
    sendError(
      res,
      404,
      "NOT_FOUND",
      "No such endpoint. GET /api/agent/v1 lists them."
    );
  });
  // Malformed JSON bodies land here instead of Express's HTML error page.
  api.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction
    ) => {
      const status =
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 500;
      sendError(
        res,
        status,
        status === 400 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
        status === 400
          ? "The request body must be valid JSON."
          : "Something went wrong."
      );
    }
  );

  return api;
}
