import { isIP } from "node:net";

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

// A validated IP key is far shorter than this; the cap is defense in depth.
const MAX_KEY_LENGTH = 48;

// Groups an IPv6 address to its /64 network, the usual single-client allocation,
// so one client holding a whole /64 cannot present a fresh key per request.
// Builds a new string, which also drops any V8 slice of the source header.
function ipv6Key(address: string): string {
  const bare = address.split("%")[0];
  // IPv4-mapped forms (::ffff:1.2.3.4) all share one network; key them whole.
  if (bare.includes(".")) return `v6:${bare}`;
  const [head, tail = ""] = bare.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const gap = 8 - headParts.length - tailParts.length;
  const full = [
    ...headParts,
    ...(gap > 0 ? Array<string>(gap).fill("0") : []),
    ...tailParts,
  ];
  const prefix = full
    .slice(0, 4)
    .map(part => parseInt(part || "0", 16).toString(16))
    .join(":");
  return `v6:${prefix}::/64`;
}

// Derives the limiter key from a validated client address. Express req.ip
// honors X-Forwarded-For only from the private-network proxies trusted in
// server/_core/index.ts, but we still re-check it: a value that is not an IP (a
// spoofed token, or a proxy that writes host:port) is dropped for the socket
// address, every IPv6 client is grouped to its /64, and the key is always a
// freshly built, length-bounded string so a crafted header cannot inflate the
// key or hold the whole header in memory.
export function getRequestIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  for (const candidate of [req.ip, req.socket?.remoteAddress]) {
    const value = candidate?.trim();
    if (!value) continue;
    const version = isIP(value);
    if (version === 4) return `v4:${value}`.slice(0, MAX_KEY_LENGTH);
    if (version === 6) return ipv6Key(value).slice(0, MAX_KEY_LENGTH);
  }
  return "unknown";
}
