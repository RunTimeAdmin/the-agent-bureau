import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ deleteAbandonedPlays: vi.fn(), pruneDailyUsage: vi.fn() }));
vi.mock("./interrogate", () => ({ askSuspect: vi.fn(), isOutOfCredit: () => false }));

import { ABANDONED_GAME_DAYS, DAILY_USAGE_KEEP_DAYS, expireGames } from "./gameExpiry";

describe("expireGames", () => {
  // Review AB-01: a game nobody finished stayed forever.
  it("deletes unfinished games started 30 days ago and counters older than a week", async () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    const deps = {
      deleteAbandonedPlays: vi.fn(async () => 7),
      pruneDailyUsage: vi.fn(async () => {}),
    };
    await expect(expireGames(now, deps)).resolves.toBe(7);
    expect(ABANDONED_GAME_DAYS).toBe(30);
    expect(deps.deleteAbandonedPlays).toHaveBeenCalledWith(new Date("2026-10-12T12:00:00Z"));
    expect(DAILY_USAGE_KEEP_DAYS).toBe(7);
    expect(deps.pruneDailyUsage).toHaveBeenCalledWith("2026-11-04");
  });

  it("fails the run when the database cannot be reached, so the schedule retries", async () => {
    const deps = {
      deleteAbandonedPlays: vi.fn(async () => {
        throw new Error("database unreachable");
      }),
      pruneDailyUsage: vi.fn(async () => {}),
    };
    await expect(expireGames(Date.now(), deps)).rejects.toThrow("database unreachable");
    expect(deps.pruneDailyUsage).not.toHaveBeenCalled();
  });
});
