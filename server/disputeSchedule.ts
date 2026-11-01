import { runDispute } from "./disputeCommand";

/** How often the server runs pnpm dispute settle. */
export const DISPUTE_SETTLE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Runs pnpm dispute settle in the server, now and then every intervalMs, so a
 * dispute the furnisher lets lapse takes its line down without anyone running
 * the command. The server reaches the database already; the command run by hand
 * from elsewhere needs a remote access rule. A run still going when the next is
 * due is not overlapped, and a failed run is logged and tried again next time.
 * Returns a function that stops the timer.
 */
export function startDisputeSettling(
  settle: () => Promise<number> = () => runDispute(["settle"]),
  intervalMs = DISPUTE_SETTLE_INTERVAL_MS
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const code = await settle();
      if (code !== 0) console.error(`[dispute settle] exited with ${code}`);
    } catch (error) {
      console.error(
        "[dispute settle] failed:",
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
