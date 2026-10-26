import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const { createInquiry, listInquiries, updateInquiryStatus } = vi.hoisted(
  () => ({
    createInquiry: vi.fn(),
    listInquiries: vi.fn(),
    updateInquiryStatus: vi.fn(),
  })
);

vi.mock("./db", () => ({
  createInquiry,
  listInquiries,
  updateInquiryStatus,
}));

import {
  appRouter,
  consumeInquiryRateLimit,
  inquiryInputSchema,
  resetInquiryRateLimiter,
} from "./routers";

function createContext(
  user: TrpcContext["user"] = null,
  ip = "198.51.100.10"
): TrpcContext {
  return {
    user,
    req: { ip, headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

const validInput = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  interest: "Hire an agent" as const,
  message: "I would like to discuss an agent engagement for our team.",
  website: "",
};

afterEach(() => {
  createInquiry.mockReset();
  listInquiries.mockReset();
  updateInquiryStatus.mockReset();
  resetInquiryRateLimiter();
});

describe("inquiry validation", () => {
  it("accepts the frontend contract and rejects clear boundary violations", () => {
    expect(inquiryInputSchema.safeParse(validInput).success).toBe(true);
    expect(
      inquiryInputSchema.safeParse({ ...validInput, name: "A" }).success
    ).toBe(false);
    expect(
      inquiryInputSchema.safeParse({ ...validInput, message: "Too short" })
        .success
    ).toBe(false);
    expect(
      inquiryInputSchema.safeParse({ ...validInput, email: "not-an-email" })
        .success
    ).toBe(false);
    expect(
      inquiryInputSchema.safeParse({ ...validInput, interest: "Other" }).success
    ).toBe(false);
  });
});

describe("inquiries.submit", () => {
  it("returns a fake reference for the honeypot without writing", async () => {
    const caller = appRouter.createCaller(createContext());
    const result = await caller.inquiries.submit({
      ...validInput,
      website: "https://bot.example",
    });

    expect(result.success).toBe(true);
    expect(result.reference).toMatch(/^INQ-\d{8}-[0-9A-F]{12}$/);
    expect(createInquiry).not.toHaveBeenCalled();
  });
});

describe("inquiry rate limiting", () => {
  it("allows five requests per IP window and blocks the sixth", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(consumeInquiryRateLimit("203.0.113.7", 1_000)).toBe(true);
    }
    expect(consumeInquiryRateLimit("203.0.113.7", 1_000)).toBe(false);
    expect(consumeInquiryRateLimit("203.0.113.8", 1_000)).toBe(true);
    expect(consumeInquiryRateLimit("203.0.113.7", 1_000 + 15 * 60 * 1000)).toBe(
      true
    );
  });
});

describe("admin inquiry procedures", () => {
  it("deny unauthenticated and non-admin inbox access", async () => {
    const unauthenticated = appRouter.createCaller(createContext());
    await expect(unauthenticated.inquiries.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const user = appRouter.createCaller(
      createContext({
        id: 1,
        openId: "regular-user",
        name: "Regular User",
        email: "user@example.com",
        loginMethod: "manus",
        role: "user",
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      })
    );
    await expect(user.inquiries.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      user.inquiries.setStatus({ id: 1, status: "reviewed" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listInquiries).not.toHaveBeenCalled();
    expect(updateInquiryStatus).not.toHaveBeenCalled();
  });
});
