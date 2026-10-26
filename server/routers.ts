import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import { createInquiry, listInquiries, updateInquiryStatus } from "./db";
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
  "Hire an agent",
  "Become a provider",
  "Partnership",
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

function getRequestIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  // Express req.ip is the framework's resolved address. Do not trust a raw
  // x-forwarded-for header; this server does not configure arbitrary proxy trust.
  return req.ip?.trim() || req.socket?.remoteAddress?.trim() || "unknown";
}

export function consumeInquiryRateLimit(ip: string, now = Date.now()): boolean {
  return inquiryRateLimit.consume(ip, now);
}

/** Reset only for isolated unit tests; production code never calls this. */
export function resetInquiryRateLimiter(): void {
  inquiryRateLimit.reset();
  loginRateLimit.reset();
}

export function generateInquiryReference(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `INQ-${date}-${randomBytes(6).toString("hex").toUpperCase()}`;
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
  }),
});

export type AppRouter = typeof appRouter;
