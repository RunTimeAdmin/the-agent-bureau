import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const { createInquiry, deleteInquiry, listInquiries, reserveDaily, updateInquiryStatus } =
  vi.hoisted(() => ({
    reserveDaily: vi.fn(),
    createInquiry: vi.fn(),
    deleteInquiry: vi.fn(),
    listInquiries: vi.fn(),
    updateInquiryStatus: vi.fn(),
  }));

vi.mock("./db", () => ({
  reserveDaily,
  createInquiry,
  deleteInquiry,
  listInquiries,
  updateInquiryStatus,
}));

import {
  appRouter,
  consumeInquiryRateLimit,
  INQUIRIES_PER_DAY,
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
  reserveDaily.mockReset();
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
    expect(reserveDaily).not.toHaveBeenCalled();
  });

  // Review AB-01: the per-address limit lives in one process, so stored
  // inquiries are also capped per day in the database.
  it("stores an inquiry while the day's total has room, and refuses once it is full", async () => {
    reserveDaily.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const caller = appRouter.createCaller(createContext());
    await expect(caller.inquiries.submit(validInput)).resolves.toMatchObject({ success: true });
    expect(reserveDaily).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), "inquiries", INQUIRIES_PER_DAY);
    expect(createInquiry).toHaveBeenCalledTimes(1);

    const other = appRouter.createCaller(createContext(false, "203.0.113.44"));
    await expect(other.inquiries.submit(validInput)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(createInquiry).toHaveBeenCalledTimes(1);
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
