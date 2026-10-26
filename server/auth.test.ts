import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRouter, resetInquiryRateLimiter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import {
  createOperatorSession,
  isOperatorRequest,
  verifyOperatorSession,
} from "./_core/auth";

type CookieCall = {
  name: string;
  value?: string;
  options: Record<string, unknown>;
};

const TEST_SECRET = "unit-test-signing-key-never-deployed-0123456789";
const TEST_PASSWORD = "correct horse battery staple";

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
  vi.stubEnv("SESSION_SECRET", TEST_SECRET);
  vi.stubEnv("OPERATOR_PASSWORD", TEST_PASSWORD);
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
    vi.stubEnv("SESSION_SECRET", "a-different-secret-that-is-long-enough-000");
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
