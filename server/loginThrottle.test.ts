import { afterEach, describe, expect, it, vi } from "vitest";

// The database's answers, as isLoginWindowFull and consumeLoginAttempt give them.
const full = vi.fn();
const consume = vi.fn();
vi.mock("./db", async importOriginal => ({
  ...(await importOriginal<typeof import("./db")>()),
  isLoginWindowFull: (...args: unknown[]) => full(...args),
  consumeLoginAttempt: (...args: unknown[]) => consume(...args),
}));

import { consumeLoginRateLimit, resetInquiryRateLimiter } from "./routers";
import { parseAddressList, requestAddressIn } from "./rateLimit";

const WINDOW = 15 * 60 * 1000;

afterEach(() => {
  full.mockReset();
  consume.mockReset();
  resetInquiryRateLimiter();
});

describe("operator sign-in limits, with a database", () => {
  it("read the count for all, then count the address and all addresses together", async () => {
    full.mockResolvedValue(false);
    consume.mockResolvedValue(true);
    expect(await consumeLoginRateLimit("v4:198.51.100.7", 1_000)).toBe(true);
    expect(full.mock.calls).toEqual([["login:all", WINDOW, 50, 1_000]]);
    expect(consume.mock.calls).toEqual([
      ["login:v4:198.51.100.7", WINDOW, 10, 1_000],
      ["login:all", WINDOW, 50, 1_000],
    ]);
  });

  it("refuse an address over its limit without counting it against everyone", async () => {
    full.mockResolvedValue(false);
    consume.mockResolvedValueOnce(false);
    expect(await consumeLoginRateLimit("v4:198.51.100.7")).toBe(false);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("refuse any address once all of them together are over the limit, writing no row for it", async () => {
    full.mockResolvedValue(true);
    expect(await consumeLoginRateLimit("v4:203.0.113.200")).toBe(false);
    expect(consume).not.toHaveBeenCalled();
  });

  it("refuse in this process first, without asking the database", async () => {
    full.mockResolvedValue(false);
    consume.mockResolvedValue(true);
    for (let n = 0; n < 10; n += 1) expect(await consumeLoginRateLimit("v4:198.51.100.7", 1_000)).toBe(true);
    full.mockClear();
    consume.mockClear();
    expect(await consumeLoginRateLimit("v4:198.51.100.7", 1_000)).toBe(false);
    expect(full).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("leave the operator's own addresses out of the count for all", async () => {
    consume.mockResolvedValue(true);
    expect(await consumeLoginRateLimit("v4:198.51.100.7", 1_000, false)).toBe(true);
    expect(full).not.toHaveBeenCalled();
    expect(consume.mock.calls).toEqual([["login:v4:198.51.100.7", WINDOW, 10, 1_000]]);
  });

  it("fail closed when the database cannot count", async () => {
    full.mockResolvedValue(false);
    consume.mockRejectedValueOnce(new Error("connection refused"));
    await expect(consumeLoginRateLimit("v4:198.51.100.7")).rejects.toThrow("connection refused");
  });
});

describe("OPERATOR_LOGIN_ADDRESSES", () => {
  it("takes addresses and networks, and names what is neither", () => {
    const { list, invalid } = parseAddressList(
      " 203.0.113.7, 2001:db8:5::/48, 10.0.0.0/33, office, 192.0.2.1/24/1, 0.0.0.0/0, 2001::/16,, "
    );
    // Not an address, or a network wider than an operator holds.
    expect(invalid).toEqual(["10.0.0.0/33", "office", "192.0.2.1/24/1", "0.0.0.0/0", "2001::/16"]);
    const from = (ip: string) => requestAddressIn(list, { ip });
    expect(from("203.0.113.7")).toBe(true);
    expect(from("203.0.113.8")).toBe(false);
    expect(from("2001:db8:5:ffff::1")).toBe(true);
    expect(from("2001:db8:6::1")).toBe(false);
    // An IPv4 client the server sees through an IPv6 socket.
    expect(from("::ffff:203.0.113.7")).toBe(true);
    expect(requestAddressIn(list, { socket: { remoteAddress: "203.0.113.7" } })).toBe(true);
    expect(requestAddressIn(list, { ip: "not-an-address" })).toBe(false);
    // An address the limit's key skips is not the operator's either: here the key is the socket's.
    expect(requestAddressIn(list, { ip: "203.0.113.7%x", socket: { remoteAddress: "192.0.2.50" } })).toBe(false);
  });
});
