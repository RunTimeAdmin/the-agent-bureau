import { createHash, timingSafeEqual } from "node:crypto";
import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { ENV } from "./env";

// Single-operator sign-in for the private inbox. The password and signing
// secret come from the environment; nothing is stored in the database.
// Rotating SESSION_SECRET signs every existing session out.

const OPERATOR_SUBJECT = "operator";
export const MIN_SESSION_SECRET_LENGTH = 32;

export function isOperatorLoginConfigured(): boolean {
  return (
    ENV.operatorPassword.length > 0 &&
    ENV.sessionSecret.length >= MIN_SESSION_SECRET_LENGTH
  );
}

function sessionKey(): Uint8Array {
  if (ENV.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`
    );
  }
  return new TextEncoder().encode(ENV.sessionSecret);
}

// Compare fixed-length digests so timing does not depend on where inputs differ.
export function checkOperatorPassword(candidate: string): boolean {
  const expected = ENV.operatorPassword;
  if (!expected) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export async function createOperatorSession(now = Date.now()): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(OPERATOR_SUBJECT)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor((now + SESSION_TTL_MS) / 1000))
    .sign(sessionKey());
}

export async function verifyOperatorSession(
  token: string | undefined
): Promise<boolean> {
  if (!token || !isOperatorLoginConfigured()) return false;
  try {
    const { payload } = await jwtVerify(token, sessionKey(), {
      algorithms: ["HS256"],
    });
    return payload.sub === OPERATOR_SUBJECT;
  } catch {
    return false;
  }
}

export function isOperatorRequest(req: Request): Promise<boolean> {
  const token = parseCookieHeader(req.headers.cookie ?? "")[COOKIE_NAME];
  return verifyOperatorSession(token);
}
