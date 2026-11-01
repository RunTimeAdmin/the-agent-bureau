import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDisputeSettling } from "./disputeSchedule";

describe("startDisputeSettling", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("settles at once and then every interval", async () => {
    const settle = vi.fn(async () => 0);
    stop = startDisputeSettling(settle, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(settle).toHaveBeenCalledTimes(4);
  });

  it("does not start a run while one is still going", async () => {
    let finish!: (code: number) => void;
    const settle = vi.fn(
      () => new Promise<number>(resolve => (finish = resolve))
    );
    stop = startDisputeSettling(settle, 1000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(settle).toHaveBeenCalledTimes(1);
    finish(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("logs a failed or unsuccessful run and keeps going", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const settle = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("database unreachable"))
      .mockResolvedValueOnce(2)
      .mockResolvedValue(0);
    stop = startDisputeSettling(settle, 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(settle).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledWith(
      "[dispute settle] failed:",
      "database unreachable"
    );
    expect(errors).toHaveBeenCalledWith("[dispute settle] exited with 2");
  });
});
