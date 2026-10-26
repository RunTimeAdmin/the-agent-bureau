import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { createInquiry, listInquiries, updateInquiryStatus } from "./db";
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

type RateLimitEntry = { windowStartedAt: number; count: number };
const inquiryRateLimit = new Map<string, RateLimitEntry>();
const INQUIRY_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const INQUIRY_RATE_LIMIT_MAX = 5;
const INQUIRY_RATE_LIMIT_MAX_KEYS = 10_000;

function getRequestIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  // Express req.ip is the framework's resolved address. Do not trust a raw
  // x-forwarded-for header; this server does not configure arbitrary proxy trust.
  return req.ip?.trim() || req.socket?.remoteAddress?.trim() || "unknown";
}

export function consumeInquiryRateLimit(ip: string, now = Date.now()): boolean {
  const key = ip.trim() || "unknown";
  const current = inquiryRateLimit.get(key);
  if (
    !current ||
    now - current.windowStartedAt >= INQUIRY_RATE_LIMIT_WINDOW_MS
  ) {
    inquiryRateLimit.delete(key);
    inquiryRateLimit.set(key, { windowStartedAt: now, count: 1 });
  } else if (current.count < INQUIRY_RATE_LIMIT_MAX) {
    current.count += 1;
    inquiryRateLimit.delete(key);
    inquiryRateLimit.set(key, current);
  } else {
    return false;
  }

  while (inquiryRateLimit.size > INQUIRY_RATE_LIMIT_MAX_KEYS) {
    const oldestKey = inquiryRateLimit.keys().next().value;
    if (oldestKey === undefined) break;
    inquiryRateLimit.delete(oldestKey);
  }
  return true;
}

/** Reset only for isolated unit tests; production code never calls this. */
export function resetInquiryRateLimiter(): void {
  inquiryRateLimit.clear();
}

export function generateInquiryReference(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `INQ-${date}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
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
