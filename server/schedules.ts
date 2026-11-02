import { runDispute } from "./disputeCommand";
import { runLines } from "./lineExpiry";

/** How often the server runs pnpm dispute settle. */
export const DISPUTE_SETTLE_INTERVAL_MS = 60 * 60 * 1000;
/** How often the server runs pnpm lines expire. */
export const LINE_EXPIRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A failed run is tried again this soon, rather than a whole interval later. */
export const RETRY_MS = 60 * 60 * 1000;

/** How a scheduled command last ended, for GET /api/jobs. */
type JobState = {
  intervalMs: number;
  startedAt: number;
  lastRunAt: number | null;
  ok: boolean | null;
  detail: string | null;
};
const jobs = new Map<string, JobState>();

/**
 * Runs a command now and then every intervalMs. A run still going when the
 * next is due is not overlapped. A failed or non-zero run is logged under
 * name, recorded for GET /api/jobs, and tried again after RETRY_MS when that
 * is sooner than the next run. Returns a function that stops the timer.
 */
export function runEvery(
  name: string,
  run: () => Promise<number>,
  intervalMs: number,
  now: () => number = Date.now
): () => void {
  const state: JobState = {
    intervalMs,
    startedAt: now(),
    lastRunAt: null,
    ok: null,
    detail: null,
  };
  jobs.set(name, state);
  let running = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const code = await run();
      state.ok = code === 0;
      state.detail = code === 0 ? null : `exited with ${code}`;
    } catch (error) {
      state.ok = false;
      state.detail = `failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      state.lastRunAt = now();
      running = false;
    }
    if (!state.ok) {
      console.error(`[${name}] ${state.detail}`);
      if (RETRY_MS < intervalMs && retry === null) {
        retry = setTimeout(() => {
          retry = null;
          void tick();
        }, RETRY_MS);
        retry.unref();
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();
  return () => {
    clearInterval(timer);
    if (retry) clearTimeout(retry);
    jobs.delete(name);
  };
}

/**
 * What GET /api/jobs answers: "ok" while every scheduled command's last run
 * succeeded and none is overdue, otherwise "attention" with the problems, so
 * the monitor that watches /api/ready can watch this too. `expected` says the
 * commands should run in this process (production, with a database); then
 * none running at all is a problem too.
 */
export function jobStatus(expected: boolean, at: number = Date.now()) {
  const problems: string[] = [];
  const out: Record<
    string,
    { last_run_at: string | null; ok: boolean | null; detail: string | null }
  > = {};
  for (const [name, s] of jobs) {
    out[name] = {
      last_run_at:
        s.lastRunAt === null ? null : new Date(s.lastRunAt).toISOString(),
      ok: s.ok,
      detail: s.detail,
    };
    if (s.ok === false) problems.push(`${name} ${s.detail}`);
    // Overdue: twice its interval, and a few minutes, since it last ran (or since it was started).
    const since = s.lastRunAt ?? s.startedAt;
    if (at - since > 2 * s.intervalMs + 5 * 60_000) {
      problems.push(
        `${name} has not run since ${new Date(since).toISOString()}`
      );
    }
  }
  if (expected && jobs.size === 0) {
    problems.push("no scheduled commands run in this process");
  }
  return problems.length === 0
    ? { status: "ok" as const, jobs: out }
    : { status: "attention" as const, problem: problems.join("; "), jobs: out };
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
