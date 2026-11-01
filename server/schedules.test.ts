import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvery } from "./schedules";

describe("runEvery", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stop?.();
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
      "[lines expire] failed:",
      "database unreachable"
    );
    expect(errors).toHaveBeenCalledWith("[lines expire] exited with 1");
  });
});
