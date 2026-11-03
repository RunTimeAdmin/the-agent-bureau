import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import { zxcvbn, zxcvbnOptions } from "@zxcvbn-ts/core";
import * as zxcvbnCommon from "@zxcvbn-ts/language-common";
import * as zxcvbnEn from "@zxcvbn-ts/language-en";
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
// zxcvbn's estimate of the guesses a password takes: 10^14 is about what 14 random printable
// characters give, and four random words give far more. A name, a season or a year with symbols
// on it falls well short, which a length rule and a list of words did not catch.
export const MIN_OPERATOR_PASSWORD_GUESSES = 1e14;
// 32 random bytes as hex, which is what the documented generator prints:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
export const MIN_SESSION_SECRET_HEX = 64;

zxcvbnOptions.setOptions({
  translations: zxcvbnEn.translations,
  graphs: zxcvbnCommon.adjacencyGraphs,
  dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEn.dictionary },
});
// Words this site's own passphrase is likely to be built from, which zxcvbn then counts as known.
const SITE_WORDS = ["bureau", "agentbureau", "theagentbureau", "counteraudit", "sigvara", "levy", "agent", "inbox", "operator", "admin"];

// The estimate takes up to a tenth of a second, and every request asks whether sign-in is on.
let estimate: { password: string; guesses: number } | null = null;
function passwordGuesses(password: string): number {
  if (estimate?.password !== password) estimate = { password, guesses: zxcvbn(password, SITE_WORDS).guesses };
  return estimate.guesses;
}

/**
 * Why OPERATOR_PASSWORD cannot be used for sign-in, or null when it can. The reasons go to the
 * host's log, so they say nothing of the password's length or what it holds.
 */
export function operatorPasswordProblem(password: string): string | null {
  if (password.length === 0) return "OPERATOR_PASSWORD is not set";
  if (password.length < MIN_OPERATOR_PASSWORD_LENGTH) {
    return `OPERATOR_PASSWORD is shorter than ${MIN_OPERATOR_PASSWORD_LENGTH} characters; use four or more random words`;
  }
  if (passwordGuesses(password) < MIN_OPERATOR_PASSWORD_GUESSES) {
    return "OPERATOR_PASSWORD is too easy to guess; use four or more random words";
  }
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
    return `SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_HEX / 2} bytes`;
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

// scrypt of the password, salted with the secret: a new password or a new secret
// is a new key, and every session signed with the old one fails. scrypt and not
// a plain hash, so that someone holding the secret and one session token cannot
// try passwords against it at hash speed. Worked out once for each pair.
let derived: { secret: string; password: string; key: Uint8Array } | null = null;
function sessionKey(): Uint8Array {
  const problems = operatorLoginProblems();
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { sessionSecret: secret, operatorPassword: password } = ENV;
  if (derived?.secret !== secret || derived.password !== password) {
    const salt = Buffer.concat([Buffer.from("bureau-operator-session-v2\0"), Buffer.from(secret, "hex")]);
    const key = scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    derived = { secret, password, key: new Uint8Array(key) };
  }
  return derived.key;
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
