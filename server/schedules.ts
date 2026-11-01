import { runDispute } from "./disputeCommand";
import { runLines } from "./lineExpiry";

/** How often the server runs pnpm dispute settle. */
export const DISPUTE_SETTLE_INTERVAL_MS = 60 * 60 * 1000;
/** How often the server runs pnpm lines expire. */
export const LINE_EXPIRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs a command now and then every intervalMs. A run still going when the
 * next is due is not overlapped, and a failed or non-zero run is logged under
 * name and tried again next time. Returns a function that stops the timer.
 */
export function runEvery(
  name: string,
  run: () => Promise<number>,
  intervalMs: number
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const code = await run();
      if (code !== 0) console.error(`[${name}] exited with ${code}`);
    } catch (error) {
      console.error(
        `[${name}] failed:`,
        error instanceof Error ? error.message : error
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

/**
 * The commands the production server runs itself, since it reaches the
 * database already; run by hand from elsewhere, they need a remote access
 * rule. Hourly, pnpm dispute settle, so a dispute the furnisher lets lapse
 * takes its line down. Daily, pnpm lines expire, so a line goes with its
 * CounterAudit source (docs/agent-file.md).
 */
export function startSchedules(): void {
  runEvery(
    "dispute settle",
    () => runDispute(["settle"]),
    DISPUTE_SETTLE_INTERVAL_MS
  );
  runEvery("lines expire", () => runLines(["expire"]), LINE_EXPIRY_INTERVAL_MS);
}
