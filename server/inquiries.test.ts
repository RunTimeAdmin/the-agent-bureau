import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const { createInquiry, deleteInquiry, listInquiries, updateInquiryStatus } =
  vi.hoisted(() => ({
    createInquiry: vi.fn(),
    deleteInquiry: vi.fn(),
    listInquiries: vi.fn(),
    updateInquiryStatus: vi.fn(),
  }));

vi.mock("./db", () => ({
  createInquiry,
  deleteInquiry,
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
  isOperator = false,
  ip = "198.51.100.10"
): TrpcContext {
  return {
    isOperator,
    req: { ip, headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

const validInput = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  interest: "Report agent outcomes" as const,
  message: "I would like to discuss an agent engagement for our team.",
  website: "",
};

afterEach(() => {
  createInquiry.mockReset();
  listInquiries.mockReset();
  updateInquiryStatus.mockReset();
  deleteInquiry.mockReset();
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
    // Retired topics stay valid in the database but are no longer accepted.
    expect(
      inquiryInputSchema.safeParse({ ...validInput, interest: "Hire an agent" })
        .success
    ).toBe(false);
    expect(
      inquiryInputSchema.safeParse({
        ...validInput,
        interest: "I operate an agent",
      }).success
    ).toBe(true);
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
  it("deny inbox access without an operator session", async () => {
    const visitor = appRouter.createCaller(createContext());
    await expect(visitor.inquiries.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      visitor.inquiries.setStatus({ id: 1, status: "reviewed" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(visitor.inquiries.remove({ id: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(listInquiries).not.toHaveBeenCalled();
    expect(updateInquiryStatus).not.toHaveBeenCalled();
    expect(deleteInquiry).not.toHaveBeenCalled();
  });

  it("allow inbox access with an operator session", async () => {
    listInquiries.mockResolvedValue([]);
    const operator = appRouter.createCaller(createContext(true));
    await expect(operator.inquiries.list()).resolves.toEqual([]);
    await operator.inquiries.setStatus({ id: 1, status: "reviewed" });
    expect(updateInquiryStatus).toHaveBeenCalledWith(1, "reviewed");
    await expect(operator.inquiries.remove({ id: 7 })).resolves.toEqual({
      success: true,
    });
    expect(deleteInquiry).toHaveBeenCalledWith(7);
  });

  it("only removes inquiries by a positive integer id", async () => {
    const operator = appRouter.createCaller(createContext(true));
    await expect(operator.inquiries.remove({ id: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      operator.inquiries.remove({ id: 1.5 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(deleteInquiry).not.toHaveBeenCalled();
  });
});
