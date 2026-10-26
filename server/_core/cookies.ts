import type { CookieOptions, Request } from "express";
import { ENV } from "./env";

export function getSessionCookieOptions(_req: Request): CookieOptions {
  // First-party session only. Secure is relaxed outside production so the
  // cookie also works on http://localhost during development.
  return {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: ENV.isProduction,
  };
}
