import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CASE_001, suspectIds, type SuspectId } from "@shared/case001";
import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
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
  createInquiry,
  createPlay,
  deleteInquiry,
  finishPlay,
  getPlay,
  listInquiries,
  listPlayQuestions,
  refundQuestion,
  updateInquiryStatus,
} from "./db";
import { askSuspect, isOutOfCredit } from "./interrogate";
import { createRateLimiter } from "./rateLimit";
import {
  checkOperatorPassword,
  createOperatorSession,
  isOperatorLoginConfigured,
} from "./_core/auth";
import { getSessionCookieOptions } from "./_core/cookies";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";

export const inquiryInterests = [
  "Report agent outcomes",
  "Request a Bureau file",
  "I operate an agent",
  "General inquiry",
] as const;

export const inquiryStatuses = ["new", "reviewed", "closed"] as const;

export const inquiryInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(120, "Name must be 120 characters or fewer"),
  email: z
    .string()
    .trim()
    .email("Email must be valid")
    .max(320, "Email must be 320 characters or fewer"),
  interest: z.enum(inquiryInterests),
  message: z
    .string()
    .trim()
    .min(20, "Message must be at least 20 characters")
    .max(4000, "Message must be 4000 characters or fewer"),
  website: z.string().trim(),
});

const inquiryStatusSchema = z.enum(inquiryStatuses);

const inquiryRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
});
const loginRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});
// Every question is a paid model call. Per-address limits stop one visitor
// from draining the day; the daily total caps the bill however many
// addresses there are.
const DAY_MS = 24 * 60 * 60 * 1000;
const playStartRateLimit = createRateLimiter({ windowMs: DAY_MS, max: 5 });
const playAskRateLimit = createRateLimiter({ windowMs: DAY_MS, max: 60 });
export const DAILY_QUESTION_LIMIT = 1500;
const CLOSED_FOR_TODAY = "The Bureau is closed for today. Come back tomorrow.";

function getRequestIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  // Express req.ip honors X-Forwarded-For only from the private-network proxies
  // trusted in server/_core/index.ts. Never read the raw header here.
  return req.ip?.trim() || req.socket?.remoteAddress?.trim() || "unknown";
}

export function consumeInquiryRateLimit(ip: string, now = Date.now()): boolean {
  return inquiryRateLimit.consume(ip, now);
}

/** Reset only for isolated unit tests; production code never calls this. */
export function resetInquiryRateLimiter(): void {
  inquiryRateLimit.reset();
  loginRateLimit.reset();
  playStartRateLimit.reset();
  playAskRateLimit.reset();
}

export function generateInquiryReference(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `INQ-${date}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

const playIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

async function assertBureauOpen(now = new Date()): Promise<void> {
  const midnightUtc = new Date(now);
  midnightUtc.setUTCHours(0, 0, 0, 0);
  if ((await countQuestionsSince(midnightUtc)) >= DAILY_QUESTION_LIMIT) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: CLOSED_FOR_TODAY,
    });
  }
}

async function loadPlay(playId: string): Promise<Play> {
  const play = await getPlay(playId);
  if (!play || play.caseId !== CASE_001.id) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That game could not be found.",
    });
  }
  return play;
}

// The answer only leaves the server once the player has made their accusation.
function playState(play: Play, questions: PlayQuestion[]) {
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

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(({ ctx }) => ({
      isOperator: ctx.isOperator,
      loginConfigured: isOperatorLoginConfigured(),
    })),
    login: publicProcedure
      .input(z.object({ password: z.string().min(1).max(256) }))
      .mutation(async ({ ctx, input }) => {
        if (!isOperatorLoginConfigured()) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Operator sign-in is not configured on this server.",
          });
        }
        if (!loginRateLimit.consume(getRequestIp(ctx.req))) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many sign-in attempts. Please try again later.",
          });
        }
        if (!checkOperatorPassword(input.password)) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "That password is not correct.",
          });
        }
        ctx.res.cookie(COOKIE_NAME, await createOperatorSession(), {
          ...getSessionCookieOptions(ctx.req),
          maxAge: SESSION_TTL_MS,
        });
        return { success: true } as const;
      }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  inquiries: router({
    submit: publicProcedure
      .input(inquiryInputSchema)
      .mutation(async ({ ctx, input }) => {
        if (!consumeInquiryRateLimit(getRequestIp(ctx.req))) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message:
              "Too many inquiries from this address. Please try again later.",
          });
        }

        const reference = generateInquiryReference();
        if (input.website) {
          return { success: true, reference } as const;
        }

        await createInquiry({
          name: input.name,
          email: input.email,
          interest: input.interest,
          message: input.message,
          reference,
        });
        return { success: true, reference } as const;
      }),
    list: adminProcedure.query(() => listInquiries()),
    setStatus: adminProcedure
      .input(
        z.object({
          id: z.number().int().positive(),
          status: inquiryStatusSchema,
        })
      )
      .mutation(async ({ input }) => {
        await updateInquiryStatus(input.id, input.status);
        return { success: true } as const;
      }),
    remove: adminProcedure
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        await deleteInquiry(input.id);
        return { success: true } as const;
      }),
  }),
  play: router({
    start: publicProcedure.mutation(async ({ ctx }) => {
      if (!playStartRateLimit.consume(getRequestIp(ctx.req))) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message:
            "That's all the cases for this address today. Come back tomorrow.",
        });
      }
      await assertBureauOpen();
      const playId = randomBytes(16).toString("hex");
      await createPlay(playId, CASE_001.id);
      return { playId };
    }),
    get: publicProcedure
      .input(z.object({ playId: playIdSchema }))
      .query(async ({ input }) => {
        const play = await loadPlay(input.playId);
        return playState(play, await listPlayQuestions(play.id));
      }),
    ask: publicProcedure
      .input(
        z.object({
          playId: playIdSchema,
          suspect: z.enum(suspectIds),
          question: z
            .string()
            .trim()
            .min(3, "Ask a full question")
            .max(280, "Keep questions to 280 characters"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (!playAskRateLimit.consume(getRequestIp(ctx.req))) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message:
              "That's all the questions for this address today. Come back tomorrow.",
          });
        }
        await assertBureauOpen();
        const play = await loadPlay(input.playId);
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
            turn => turn.suspect === input.suspect
          );
          answer = await askSuspect(
            suspectPrompt(input.suspect),
            history,
            input.question
          );
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

        await addPlayQuestion({
          playId: play.id,
          suspect: input.suspect,
          question: input.question,
          answer,
        });
        return { answer };
      }),
    accuse: publicProcedure
      .input(z.object({ playId: playIdSchema, suspect: z.enum(suspectIds) }))
      .mutation(async ({ input }) => {
        const play = await loadPlay(input.playId);
        // A second accusation changes nothing: the first one stands.
        await finishPlay(
          play.id,
          input.suspect,
          input.suspect === CASE_001_MOLE
        );
        const closed = await loadPlay(play.id);
        return playState(closed, await listPlayQuestions(play.id));
      }),
  }),
});

export type AppRouter = typeof appRouter;
