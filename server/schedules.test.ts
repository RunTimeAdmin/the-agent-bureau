import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jobStatus, RETRY_MS, runEvery } from "./schedules";

describe("runEvery", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs at once and then every interval", async () => {
    const run = vi.fn(async () => 0);
    stop = runEvery("dispute settle", run, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("does not start a run while one is still going", async () => {
    let finish!: (code: number) => void;
    const run = vi.fn(() => new Promise<number>(resolve => (finish = resolve)));
    stop = runEvery("lines expire", run, 1000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(1);
    finish(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("logs a failed or unsuccessful run under its name and keeps going", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("database unreachable"))
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    stop = runEvery("lines expire", run, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledWith(
      "[lines expire] failed: database unreachable"
    );
    expect(errors).toHaveBeenCalledWith("[lines expire] exited with 1");
  });

  it("tries a failed daily run again after an hour, not a day", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    stop = runEvery("lines expire", run, 24 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);
    // Succeeded: no more retries before the next daily run.
    await vi.advanceTimersByTimeAsync(5 * RETRY_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("jobStatus (GET /api/jobs)", () => {
  let stops: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is ok while each command's last run succeeded", async () => {
    stops.push(runEvery("dispute settle", async () => 0, 1000));
    await vi.advanceTimersByTimeAsync(0);
    const status = jobStatus(true);
    expect(status.status).toBe("ok");
    expect(status.jobs["dispute settle"]).toMatchObject({
      ok: true,
      detail: null,
    });
  });

  it("asks for attention after a failed run, and says which and why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stops.push(runEvery("dispute settle", async () => 0, 1000));
    stops.push(runEvery("lines expire", async () => 1, 1000));
    await vi.advanceTimersByTimeAsync(0);
    expect(jobStatus(true)).toMatchObject({
      status: "attention",
      problem: "lines expire exited with 1",
    });
  });

  it("asks for attention when a command has not run for twice its interval", async () => {
    let finish!: (code: number) => void;
    stops.push(
      runEvery(
        "lines expire",
        () => new Promise<number>(r => (finish = r)),
        60_000
      )
    );
    // Stuck in its first run.
    const later = Date.now() + 2 * 60_000 + 6 * 60_000;
    expect(jobStatus(true, later).status).toBe("attention");
    expect(jobStatus(true, later)).toMatchObject({
      problem: expect.stringContaining("lines expire has not run since"),
    });
    finish(0);
  });

  it("asks for attention when the commands should run here and none does", () => {
    expect(jobStatus(true)).toMatchObject({
      status: "attention",
      problem: "no scheduled commands run in this process",
    });
    expect(jobStatus(false).status).toBe("ok");
  });
});
