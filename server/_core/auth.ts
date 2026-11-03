import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import { ENV } from "./env";

// Single-operator sign-in for the private inbox. The password and signing
// secret come from the environment; nothing is stored in the database.
// Sessions are signed with a key derived from both, so changing either one
// signs every existing session out.
//
// Sign-in stays off unless both are strong. A weak value is refused at start,
// not used: the documentation asked for a long passphrase and a random secret,
// and nothing used to check that it got them (review AB-03, 2026-11-03).

const OPERATOR_SUBJECT = "operator";
export const MIN_OPERATOR_PASSWORD_LENGTH = 16;
// 32 random bytes as hex, which is what the documented generator prints:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
export const MIN_SESSION_SECRET_HEX = 64;

// Words a passphrase is often built from by someone filling in a form. A
// password that contains one is refused whatever else it holds.
const WEAK_PASSWORD_PARTS = ["password", "changeme", "operator", "bureau", "letmein", "qwerty", "123456", "admin"];

/** Why OPERATOR_PASSWORD cannot be used for sign-in, or null when it can. */
export function operatorPasswordProblem(password: string): string | null {
  if (password.length === 0) return "OPERATOR_PASSWORD is not set";
  if (password.length < MIN_OPERATOR_PASSWORD_LENGTH) {
    return `OPERATOR_PASSWORD has ${password.length} characters; use a passphrase of at least ${MIN_OPERATOR_PASSWORD_LENGTH}`;
  }
  if (new Set(password).size < 8) {
    return "OPERATOR_PASSWORD repeats too few characters to be a passphrase";
  }
  const lower = password.toLowerCase();
  const weak = WEAK_PASSWORD_PARTS.find(part => lower.includes(part));
  if (weak) return `OPERATOR_PASSWORD contains "${weak}"`;
  return null;
}

/**
 * Why SESSION_SECRET cannot sign sessions, or null when it can. It must be the
 * hex of at least 32 random bytes. Randomness cannot be proved from the value,
 * so this refuses the ways a hand-made one gives itself away: too short, not
 * hex, too few different digits, or one block repeated.
 */
export function sessionSecretProblem(secret: string): string | null {
  if (secret.length === 0) return "SESSION_SECRET is not set";
  if (!/^[0-9a-fA-F]+$/.test(secret) || secret.length % 2 !== 0) {
    return "SESSION_SECRET must be hex: generate it with crypto.randomBytes(32).toString('hex')";
  }
  if (secret.length < MIN_SESSION_SECRET_HEX) {
    return `SESSION_SECRET has ${secret.length / 2} bytes; it needs at least ${MIN_SESSION_SECRET_HEX / 2}`;
  }
  const lower = secret.toLowerCase();
  if (new Set(lower).size < 12) return "SESSION_SECRET uses too few different hex digits to be random";
  for (let period = 1; period <= lower.length / 2; period += 1) {
    if (lower.length % period === 0 && lower.slice(0, period).repeat(lower.length / period) === lower) {
      return "SESSION_SECRET is one block repeated, not random";
    }
  }
  return null;
}

/** Every reason operator sign-in is off; empty when it is on. */
export function operatorLoginProblems(): string[] {
  return [operatorPasswordProblem(ENV.operatorPassword), sessionSecretProblem(ENV.sessionSecret)]
    .filter((p): p is string => p !== null);
}

export function isOperatorLoginConfigured(): boolean {
  return operatorLoginProblems().length === 0;
}

// HMAC-SHA256 under the secret over a hash of the password: a new password or a
// new secret is a new key, and every session signed with the old one fails.
function sessionKey(): Uint8Array {
  const problems = operatorLoginProblems();
  if (problems.length > 0) throw new Error(problems.join("; "));
  const passwordDigest = createHash("sha256").update(ENV.operatorPassword).digest();
  return new Uint8Array(
    createHmac("sha256", Buffer.from(ENV.sessionSecret, "hex"))
      .update("bureau-operator-session-v1\0")
      .update(passwordDigest)
      .digest()
  );
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
