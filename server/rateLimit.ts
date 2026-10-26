type RateLimitEntry = { windowStartedAt: number; count: number };

// In-memory fixed-window limiter keyed by client address. Resets on restart and
// is per-process, so it is a first line of defense, not a distributed control.
export function createRateLimiter({
  windowMs,
  max,
  maxKeys = 10_000,
}: {
  windowMs: number;
  max: number;
  maxKeys?: number;
}) {
  const entries = new Map<string, RateLimitEntry>();
  return {
    consume(rawKey: string, now = Date.now()): boolean {
      const key = rawKey.trim() || "unknown";
      const current = entries.get(key);
      if (!current || now - current.windowStartedAt >= windowMs) {
        entries.delete(key);
        entries.set(key, { windowStartedAt: now, count: 1 });
      } else if (current.count < max) {
        current.count += 1;
        entries.delete(key);
        entries.set(key, current);
      } else {
        return false;
      }

      while (entries.size > maxKeys) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }
      return true;
    },
    reset(): void {
      entries.clear();
    },
  };
}
