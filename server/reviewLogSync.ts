// The review log at CounterAudit (docs/review-log-design.md). sync: the operator reads every
// packet of the review organization with the Bureau's own read key, in sequence order, checking
// each links to the one before, so a gap is reported rather than read past. submit: a reviewer
// seals one record with their own ingest key, and keeps the receipt.
import type { InsertReviewLogRecord, ReviewLogRecordRow } from "../drizzle/schema";
import { isRecord } from "./outcomeProof";
import { REVIEW_CONNECTOR_ID } from "./reviewLog";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const PAGE = 100;
const MAX_PAGES = 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
// A new CounterAudit organization's chain starts at sequence 0, linked to this.
const CHAIN_START = "0".repeat(64);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** CounterAudit's base URL: https, or plain http to this machine only, since requests carry a key. */
export function counterauditBase(raw: string): string {
  const url = new URL(raw);
  const local = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) {
    throw new Error("COUNTERAUDIT_API_URL must be an https URL (or http to localhost) with no credentials, query or fragment");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

async function call(
  fetchImpl: Fetch,
  url: string,
  key: string,
  init: RequestInit = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    // Never follow one: the request carries a key.
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("CounterAudit's answer is too large");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export type ReadResult = {
  // Packets to store, in sequence order, each linked to the one before.
  rows: InsertReviewLogRecord[];
  // Why reading stopped early, or null.
  problem: string | null;
};

/**
 * Reads the review organization's packets that `known` does not hold yet. Every packet's body
 * comes from CounterAudit's verify route, which checks the packet's seal and hashes; this checks
 * the organization, and that each packet's sequence and previous hash follow the one before it.
 */
export async function readReviewLog(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  known: ReviewLogRecordRow[];
  fetch?: Fetch;
  now?: Date;
}): Promise<ReadResult> {
  const fetchImpl = options.fetch ?? fetch;
  const base = counterauditBase(options.apiUrl);
  const now = options.now ?? new Date();
  const knownIds = new Set(options.known.map(r => r.packetId));

  // Every packet id, newest first.
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) return { rows: [], problem: "the review log has more packets than one sync reads" };
    const query = new URLSearchParams({ limit: String(PAGE), ...(cursor ? { cursor } : {}) });
    const listed = await call(fetchImpl, `${base}/v1/audit/packets?${query}`, options.readKey);
    if (listed.status !== 200 || !isRecord(listed.body) || !Array.isArray(listed.body.packets)) {
      return { rows: [], problem: `CounterAudit answered ${listed.status} when listing the review log's packets` };
    }
    for (const p of listed.body.packets) {
      if (isRecord(p) && typeof p.packet_id === "string" && UUID.test(p.packet_id)) ids.push(p.packet_id);
    }
    const next = listed.body.next_cursor;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }

  const fresh: InsertReviewLogRecord[] = [];
  for (const id of ids) {
    if (knownIds.has(id)) continue;
    const got = await call(fetchImpl, `${base}/v1/audit/verify/${id}`, options.readKey);
    if (got.status === 410) {
      return { rows: [], problem: `packet ${id} has been erased; the review log must keep every packet` };
    }
    const body = got.body;
    if (got.status !== 200 || !isRecord(body) || body.valid !== true || !isRecord(body.packet)) {
      return { rows: [], problem: `CounterAudit could not verify packet ${id} (${got.status})` };
    }
    const packet = body.packet;
    const integrity = isRecord(packet.integrity) ? packet.integrity : {};
    if (packet.org_id !== options.orgId) {
      return { rows: [], problem: `packet ${id} belongs to another organization` };
    }
    const sequence = packet.sequence;
    const prevHash = integrity.prev_hash;
    const entryHash = integrity.entry_hash;
    const sealedAt = typeof packet.created_at === "string" ? new Date(packet.created_at) : new Date(NaN);
    if (
      typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 ||
      typeof prevHash !== "string" || !HASH.test(prevHash) ||
      typeof entryHash !== "string" || !HASH.test(entryHash) || entryHash !== body.entry_hash ||
      Number.isNaN(sealedAt.getTime()) ||
      typeof packet.connector_id !== "string"
    ) {
      return { rows: [], problem: `packet ${id} is missing its sequence, hashes or time` };
    }
    const isReview = packet.connector_id === REVIEW_CONNECTOR_ID;
    fresh.push({
      sequence,
      packetId: id,
      prevHash,
      entryHash,
      connectorId: packet.connector_id.slice(0, 64),
      sealedAt,
      record: isReview && isRecord(packet.signed_event) ? packet.signed_event : null,
      readAt: now,
    });
  }

  // The chain starts at sequence 0, and each packet follows the one before it: the next
  // sequence, and its previous hash that packet's entry hash. Stop at the first that does not,
  // so nothing past a gap counts.
  const all = [
    ...options.known.map(r => ({ ...r, isNew: false })),
    ...fresh.map(r => ({ ...r, isNew: true })),
  ].sort((a, b) => a.sequence - b.sequence);
  if (all.length > 0 && (all[0].sequence !== 0 || all[0].prevHash !== CHAIN_START)) {
    return { rows: [], problem: `the review log does not start at sequence 0 (its first packet is ${all[0].sequence})` };
  }
  const rows: InsertReviewLogRecord[] = [];
  for (let i = 0; i < all.length; i++) {
    const row = all[i];
    const before = all[i - 1];
    if (before && (row.sequence !== before.sequence + 1 || row.prevHash !== before.entryHash)) {
      return {
        rows,
        problem:
          row.sequence === before.sequence
            ? `two packets claim sequence ${row.sequence}`
            : `the chain breaks between sequence ${before.sequence} and ${row.sequence}; read up to ${before.sequence}`,
      };
    }
    if (row.isNew) {
      const { isNew: _isNew, ...stored } = row;
      rows.push(stored);
    }
  }
  return { rows, problem: null };
}

/** Seals one review record in the review organization with a reviewer's own ingest key. */
export async function submitReviewRecord(
  record: Record<string, unknown>,
  options: { apiUrl: string; ingestKey: string; fetch?: Fetch }
): Promise<
  | { ok: true; packetId: string; sequence: number | null; created: boolean; receipt: unknown }
  | { ok: false; reason: string }
> {
  const base = counterauditBase(options.apiUrl);
  let res: { status: number; body: unknown };
  try {
    res = await call(options.fetch ?? fetch, `${base}/v1/audit/ingest`, options.ingestKey, {
      method: "POST",
      body: JSON.stringify({ connector_id: REVIEW_CONNECTOR_ID, raw_event: record }),
    });
  } catch (error) {
    return { ok: false, reason: `could not reach CounterAudit: ${(error as Error).message}` };
  }
  const body = isRecord(res.body) ? res.body : {};
  if ((res.status === 201 || res.status === 200) && typeof body.packet_id === "string" && UUID.test(body.packet_id)) {
    return {
      ok: true,
      packetId: body.packet_id,
      sequence: typeof body.sequence === "number" ? body.sequence : null,
      created: res.status === 201,
      // CounterAudit's signed receipt: the reviewer's proof the record was sealed at this place.
      receipt: body.receipt ?? null,
    };
  }
  const what = [body.error, body.message].filter(v => typeof v === "string").join(": ").slice(0, 300);
  return { ok: false, reason: `CounterAudit refused it (${res.status}${what ? ` ${what}` : ""})` };
}
