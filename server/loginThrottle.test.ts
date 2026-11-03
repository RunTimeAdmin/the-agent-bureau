import { afterEach, describe, expect, it, vi } from "vitest";

// The database's answer for each attempt, as consumeLoginAttempt gives it.
const consume = vi.fn();
vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  consumeLoginAttempt: (...args: unknown[]) => consume(...args),
}));

import { consumeLoginRateLimit, resetInquiryRateLimiter } from "./routers";

const WINDOW = 15 * 60 * 1000;

afterEach(() => {
  consume.mockReset();
  resetInquiryRateLimiter();
});

describe("operator sign-in limits, with a database", () => {
  it("count the address, then all addresses together, in the database", async () => {
    consume.mockResolvedValue(true);
    expect(await consumeLoginRateLimit("v4:198.51.100.7", 1_000)).toBe(true);
    expect(consume.mock.calls).toEqual([
      ["login:v4:198.51.100.7", WINDOW, 10, 1_000],
      ["login:all", WINDOW, 50, 1_000],
    ]);
  });

  it("refuse an address over its limit without counting it against everyone", async () => {
    consume.mockResolvedValueOnce(false);
    expect(await consumeLoginRateLimit("v4:198.51.100.7")).toBe(false);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("refuse any address once all of them together are over the limit", async () => {
    consume.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await consumeLoginRateLimit("v4:203.0.113.200")).toBe(false);
  });

  it("fail closed when the database cannot count", async () => {
    consume.mockRejectedValueOnce(new Error("connection refused"));
    await expect(consumeLoginRateLimit("v4:198.51.100.7")).rejects.toThrow("connection refused");
  });
});
