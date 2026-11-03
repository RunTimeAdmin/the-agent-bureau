import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter, resetInquiryRateLimiter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import {
  createOperatorSession,
  isOperatorRequest,
  operatorPasswordProblem,
  sessionSecretProblem,
  verifyOperatorSession,
} from "./_core/auth";

type CookieCall = {
  name: string;
  value?: string;
  options: Record<string, unknown>;
};

// 32 bytes of hex, made for this test file and never deployed.
const TEST_SECRET = "4f1c9a7e2b6d03c58e9f71a2d4b60c3e57a9f2183c6e0d4b9a1f7e25c08d36b1";
const OTHER_SECRET = "9b3e0f6a1c7d25e84f0a6b9c3d1e72f5a8c40b6e1d9f37a2c5e08b4d6f1a39c7";
// Four random words, made for this test file and never deployed.
const TEST_PASSWORD = "lantern quarry velvet osprey";

function createContext(isOperator = false, ip = "198.51.100.20") {
  const setCookies: CookieCall[] = [];
  const clearedCookies: CookieCall[] = [];
  const ctx: TrpcContext = {
    isOperator,
    req: { ip, protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        setCookies.push({ name, value, options });
      },
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as unknown as TrpcContext["res"],
  };
  return { ctx, setCookies, clearedCookies };
}

beforeEach(() => {
  // No database: the limits below count in this process, and never in a real one.
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("OPERATOR_PASSWORD", TEST_PASSWORD);
  vi.stubEnv("OPERATOR_LOGIN_ADDRESSES", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetInquiryRateLimiter();
});

describe("auth.login", () => {
  it("sets a session cookie that the server accepts", async () => {
    const { ctx, setCookies } = createContext();
    const result = await appRouter
      .createCaller(ctx)
      .auth.login({ password: TEST_PASSWORD });

    expect(result).toEqual({ success: true });
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]?.name).toBe(COOKIE_NAME);
    expect(setCookies[0]?.options).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    const req = {
      headers: { cookie: `${COOKIE_NAME}=${setCookies[0]?.value}` },
    } as TrpcContext["req"];
    expect(await isOperatorRequest(req)).toBe(true);
  });

  it("rejects a wrong password without setting a cookie", async () => {
    const { ctx, setCookies } = createContext();
    await expect(
      appRouter.createCaller(ctx).auth.login({ password: "guess" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(setCookies).toHaveLength(0);
  });

  it("refuses sign-in when the server is not configured", async () => {
    vi.stubEnv("OPERATOR_PASSWORD", "");
    const { ctx } = createContext();
    await expect(
      appRouter.createCaller(ctx).auth.login({ password: TEST_PASSWORD })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    vi.stubEnv("OPERATOR_PASSWORD", TEST_PASSWORD);
    vi.stubEnv("SESSION_SECRET", "too-short");
    await expect(
      appRouter.createCaller(ctx).auth.login({ password: TEST_PASSWORD })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("stays off with a weak password or secret, even when that is the password given", async () => {
    const { ctx } = createContext();
    vi.stubEnv("OPERATOR_PASSWORD", "hunter2");
    await expect(
      appRouter.createCaller(ctx).auth.login({ password: "hunter2" })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    vi.stubEnv("OPERATOR_PASSWORD", TEST_PASSWORD);
    // Long enough, but a phrase and not the hex of random bytes.
    vi.stubEnv("SESSION_SECRET", "unit-test-signing-key-never-deployed-0123456789");
    await expect(
      appRouter.createCaller(ctx).auth.login({ password: TEST_PASSWORD })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await appRouter.createCaller(ctx).auth.me()).toMatchObject({ loginConfigured: false });
  });

  it("limits attempts spread over many addresses too", async () => {
    // 50 attempts from 50 addresses, each under its own limit of 10, fill the window for all of them.
    for (let n = 0; n < 50; n += 1) {
      const caller = appRouter.createCaller(createContext(false, `203.0.113.${n + 1}`).ctx);
      await expect(caller.auth.login({ password: "guess" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    const fresh = appRouter.createCaller(createContext(false, "198.51.100.99").ctx);
    await expect(fresh.auth.login({ password: TEST_PASSWORD })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });

  it("still lets the operator in from an address in OPERATOR_LOGIN_ADDRESSES once the others filled the limit", async () => {
    vi.stubEnv("OPERATOR_LOGIN_ADDRESSES", "198.51.100.0/24, 2001:db8:5::/48");
    // Five addresses, ten guesses each, fill the window for everyone else.
    for (let n = 0; n < 50; n += 1) {
      const caller = appRouter.createCaller(createContext(false, `203.0.113.${(n % 5) + 1}`).ctx);
      await expect(caller.auth.login({ password: "guess" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    const other = appRouter.createCaller(createContext(false, "192.0.2.10").ctx);
    await expect(other.auth.login({ password: TEST_PASSWORD })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    for (const ip of ["198.51.100.99", "2001:db8:5:1::20"]) {
      const operator = appRouter.createCaller(createContext(false, ip).ctx);
      await expect(operator.auth.login({ password: TEST_PASSWORD })).resolves.toEqual({ success: true });
    }
  });

  it("limits repeated attempts from one address", async () => {
    const { ctx } = createContext();
    const caller = appRouter.createCaller(ctx);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(caller.auth.login({ password: "guess" })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }
    await expect(
      caller.auth.login({ password: TEST_PASSWORD })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("operator sessions", () => {
  it("reject tokens signed with a different secret", async () => {
    const token = await createOperatorSession();
    expect(await verifyOperatorSession(token)).toBe(true);
    vi.stubEnv("SESSION_SECRET", OTHER_SECRET);
    expect(await verifyOperatorSession(token)).toBe(false);
  });

  it("reject tokens signed before the password changed", async () => {
    const token = await createOperatorSession();
    expect(await verifyOperatorSession(token)).toBe(true);
    const rotated = "harbor tinsel walrus quorum";
    // Strong enough to sign in with, so it is the change that refuses the token.
    expect(operatorPasswordProblem(rotated)).toBeNull();
    vi.stubEnv("OPERATOR_PASSWORD", rotated);
    expect(await verifyOperatorSession(token)).toBe(false);
  });

  it("reject expired tokens", async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const token = await createOperatorSession(eightDaysAgo);
    expect(await verifyOperatorSession(token)).toBe(false);
  });

  it("report visitor and operator state through auth.me", async () => {
    const visitor = createContext(false).ctx;
    expect(await appRouter.createCaller(visitor).auth.me()).toEqual({
      isOperator: false,
      loginConfigured: true,
    });
    const operator = createContext(true).ctx;
    expect(await appRouter.createCaller(operator).auth.me()).toMatchObject({
      isOperator: true,
    });
  });
});

describe("auth.logout", () => {
  it("clears the session cookie and reports success", async () => {
    const { ctx, clearedCookies } = createContext(true);
    const result = await appRouter.createCaller(ctx).auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
    expect(clearedCookies[0]?.options).toMatchObject({
      maxAge: -1,
      sameSite: "strict",
      httpOnly: true,
      path: "/",
    });
  });
});

describe("operator credentials", () => {
  it("take random words and refuse a short password or one built the way people build them", () => {
    expect(operatorPasswordProblem(TEST_PASSWORD)).toBeNull();
    expect(operatorPasswordProblem("plinth-oxbow-cadenza-myrtle")).toBeNull();
    expect(operatorPasswordProblem("")).toMatch(/not set/);
    expect(operatorPasswordProblem("short one")).toBe(
      "OPERATOR_PASSWORD is shorter than 16 characters; use four or more random words"
    );
    // Each passed the rule this replaced: 16 characters, 8 different, none of a list of words.
    for (const weak of [
      "aaaabbbbaaaabbbbaaaa",
      "MyBureauPassword2026!",
      "CounterAudit2026!",
      "Sigvara2026!!!!!",
      "Summer2026Summer",
      "Welcome2026!!!!!",
      "Adm1nistrator2026",
      "abcdefghijklmnop",
      "1q2w3e4r5t6y7u8i",
      "agent-bureau-inbox",
      "Tr0ub4dor&3Tr0ub4dor&3",
    ]) {
      // The reason goes to the host's log, so it says nothing of what the password holds.
      expect(operatorPasswordProblem(weak), weak).toBe(
        "OPERATOR_PASSWORD is too easy to guess; use four or more random words"
      );
    }
  });

  it("keep sessions and sign-in across a newline pasted around the secret", async () => {
    const token = await createOperatorSession();
    vi.stubEnv("SESSION_SECRET", ` ${TEST_SECRET}\n`);
    expect(await verifyOperatorSession(token)).toBe(true);
    expect(await appRouter.createCaller(createContext().ctx).auth.me()).toMatchObject({ loginConfigured: true });
  });

  it("take the hex of 32 random bytes and refuse a phrase, a short one or a pattern", () => {
    expect(sessionSecretProblem(TEST_SECRET)).toBeNull();
    expect(sessionSecretProblem("")).toMatch(/not set/);
    expect(sessionSecretProblem("unit-test-signing-key-never-deployed-0123456789")).toMatch(/must be hex/);
    expect(sessionSecretProblem(TEST_SECRET.slice(0, 62))).toBe("SESSION_SECRET is shorter than 32 bytes");
    expect(sessionSecretProblem("0".repeat(64))).toMatch(/too few different/);
    expect(sessionSecretProblem("0123456789abcdef".repeat(4))).toMatch(/repeated/);
  });
});
