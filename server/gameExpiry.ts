import { deleteAbandonedPlays, pruneDailyUsage } from "./db";
import { utcDayKey } from "./game";

// Review AB-01 (11 November): a game nobody finishes used to stay forever, so
// starts alone could grow the plays table without end. An unfinished game is
// deleted, with its questions and replies, this many days after it started; the
// information page says so. Finished games stay, for the scoreboard.
export const ABANDONED_GAME_DAYS = 30;
// Only today's daily counters are read; older ones are kept a week for looking
// back at a busy day, then dropped.
export const DAILY_USAGE_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes abandoned games and old daily counters. Returns how many games went. */
export async function expireGames(
  now = Date.now(),
  deps = { deleteAbandonedPlays, pruneDailyUsage }
): Promise<number> {
  const games = await deps.deleteAbandonedPlays(new Date(now - ABANDONED_GAME_DAYS * DAY_MS));
  await deps.pruneDailyUsage(utcDayKey(new Date(now - DAILY_USAGE_KEEP_DAYS * DAY_MS)));
  return games;
}

/** The scheduled run (server/schedules.ts): 0 once both deletes have gone through. */
export async function runGameExpiry(): Promise<number> {
  const games = await expireGames();
  if (games > 0) {
    console.log(`[games expire] deleted ${games} unfinished game(s) started over ${ABANDONED_GAME_DAYS} days ago`);
  }
  return 0;
}
