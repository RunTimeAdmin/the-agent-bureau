// The review log at CounterAudit (docs/review-log-design.md). sync: the operator reads every
// packet of the review organization with the Bureau's own read key, in sequence order, checking
// each links to the one before, so a gap is reported rather than read past. submit: a reviewer
// seals one record with their own ingest key, and keeps the receipt.
//
// Links show a packet missing from the middle, not from the end: a listing that stops early, from
// a stale or dishonest endpoint, still links. So every read also takes CounterAudit's signed chain
// checkpoint, the tip sequence and entry hash signed with its export key, and the log read must
// reach it (review AB-01, docs/review-log-design.md "The signed head").
import { randomBytes } from "node:crypto";
import type { InsertReviewLogRecord, ReviewLogRecordRow } from "../drizzle/schema";
import { COUNTERAUDIT_EXPORT_KEYS } from "./counterauditKeys";
import { isRecord, verifyCounterauditSignature } from "./outcomeProof";
import { REVIEW_CONNECTOR_ID, REVIEW_ORG_ID } from "./reviewLog";

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

export async function call(
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

/** A point in the review log: a sequence and the entry hash of the packet there. */
export type Head = { sequence: number; entryHash: string };

/** CounterAudit's signed chain checkpoint for the review organization. */
export type Checkpoint = Head & { packetId: string; issuedAt: Date };

const CHECKPOINT_TYPE = "counteraudit.chain_checkpoint";
const HEAD_ATTESTATION_TYPE = "counteraudit.chain_head_attestation";
// How far CounterAudit's clock may run from this one when it says when it answered.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// A read that fails still gives back a checkpoint whose own signature checked out, for the caller
// to record: one CounterAudit signed is a head the next read must reach, whatever its attestation.
type CheckpointRead =
  | { ok: true; head: Checkpoint | null }
  | { ok: false; problem: string; checkpoint?: Checkpoint | null; retry?: boolean };

/**
 * The review organization's newest chain checkpoint, attested by CounterAudit as the head over a
 * nonce made for this read. CounterAudit issues a checkpoint for the current tip when it has
 * moved, then returns the newest, signed with its export key; the key is the one pinned in
 * server/counterauditKeys.ts, not one the same server hands out. A checkpoint alone is served
 * unchanged until the tip moves, so an old one replayed with the log cut to it would look like a
 * log nothing was sealed in since. The head attestation over this read's own nonce cannot be
 * replayed, and says whether the checkpoint was the head when CounterAudit answered. `head` is
 * null only for a log CounterAudit attests has no numbered packet.
 */
export async function readCheckpoint(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  fetch?: Fetch;
  /** What the organization's chain is, for the problems: "the review log" unless given. */
  of?: string;
}): Promise<{ ok: true; head: Checkpoint | null } | { ok: false; problem: string; checkpoint: Checkpoint | null }> {
  // Once more when packets kept arriving while CounterAudit answered.
  const first = await readAttestedCheckpoint(options);
  const read = !first.ok && first.retry ? await readAttestedCheckpoint(options) : first;
  return read.ok ? read : { ok: false, problem: read.problem, checkpoint: read.checkpoint ?? null };
}

async function readAttestedCheckpoint(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  fetch?: Fetch;
  of?: string;
}): Promise<CheckpointRead> {
  const of = options.of ?? "the review log";
  const nonce = randomBytes(16).toString("hex");
  const sentAt = Date.now();
  const got = await call(
    options.fetch ?? fetch,
    `${counterauditBase(options.apiUrl)}/v1/audit/chain/${options.orgId}/checkpoint?nonce=${nonce}`,
    options.readKey
  );
  const receivedAt = Date.now();
  const window = { sentAt, receivedAt };
  if (got.status === 404 && isRecord(got.body) && got.body.error === "not_found") {
    const problem = attestationProblem(got.body, options.orgId, nonce, window, null, of);
    return problem ? { ...problem, checkpoint: null } : { ok: true, head: null };
  }
  const cp = isRecord(got.body) && isRecord(got.body.checkpoint) ? got.body.checkpoint : null;
  if (got.status !== 200 || !cp) {
    return { ok: false, problem: `CounterAudit answered ${got.status} for ${of}'s signed checkpoint` };
  }
  const { signature, ...payload } = cp;
  const signed = verifyCounterauditSignature(payload, signature, COUNTERAUDIT_EXPORT_KEYS);
  if (!signed.valid) {
    return { ok: false, problem: `${of}'s checkpoint is not signed with CounterAudit's export key (${signed.reason})` };
  }
  const issuedAt = typeof payload.issued_at === "string" ? new Date(payload.issued_at) : new Date(NaN);
  if (
    payload.checkpoint_type !== CHECKPOINT_TYPE ||
    payload.checkpoint_version !== 1 ||
    typeof payload.sequence !== "number" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 0 ||
    typeof payload.entry_hash !== "string" || !HASH.test(payload.entry_hash) ||
    typeof payload.packet_id !== "string" || !UUID.test(payload.packet_id) ||
    Number.isNaN(issuedAt.getTime())
  ) {
    return { ok: false, problem: `${of}'s checkpoint is not a version 1 chain checkpoint` };
  }
  if (payload.org_id !== options.orgId) {
    return { ok: false, problem: `${of}'s checkpoint is for another organization` };
  }
  const head = { sequence: payload.sequence, entryHash: payload.entry_hash, packetId: payload.packet_id, issuedAt };
  const problem = attestationProblem(got.body, options.orgId, nonce, window, head, of);
  return problem ? { ...problem, checkpoint: head } : { ok: true, head };
}

/**
 * Why the head attestation in CounterAudit's answer does not show `head` (or, for null, an empty
 * log) is the review log's head now, or null when it does. It must be signed with the pinned
 * export key, for the review organization, over this read's nonce, made between sending the read
 * and its answer (give or take CLOCK_SKEW_MS), `current`, and name the same checkpoint.
 */
function attestationProblem(
  body: unknown,
  orgId: string,
  nonce: string,
  window: { sentAt: number; receivedAt: number },
  head: Checkpoint | null,
  of: string
): { ok: false; problem: string; retry?: boolean } | null {
  const attestation = isRecord(body) && isRecord(body.attestation) ? body.attestation : null;
  if (!attestation) {
    return { ok: false, problem: `CounterAudit's answer for ${of}'s head carries no attestation over this read's nonce` };
  }
  const { signature, ...payload } = attestation;
  const signed = verifyCounterauditSignature(payload, signature, COUNTERAUDIT_EXPORT_KEYS);
  if (!signed.valid) {
    return { ok: false, problem: `${of}'s head attestation is not signed with CounterAudit's export key (${signed.reason})` };
  }
  if (payload.attestation_type !== HEAD_ATTESTATION_TYPE || payload.attestation_version !== 1) {
    return { ok: false, problem: `${of}'s head attestation is not a version 1 head attestation` };
  }
  if (payload.org_id !== orgId) {
    return { ok: false, problem: `${of}'s head attestation is for another organization` };
  }
  if (payload.nonce !== nonce) {
    return { ok: false, problem: `${of}'s head attestation answers another read's nonce: an old answer, replayed` };
  }
  const servedAt = typeof payload.served_at === "string" ? Date.parse(payload.served_at) : NaN;
  if (!(servedAt >= window.sentAt - CLOCK_SKEW_MS && servedAt <= window.receivedAt + CLOCK_SKEW_MS)) {
    // Both times, so a clock set wrong here can be told from an old answer.
    const said = Number.isNaN(servedAt) ? "no time" : new Date(servedAt).toISOString();
    return {
      ok: false,
      problem: `${of}'s head attestation was not made during this read: CounterAudit says it answered at ${said}, and this read ran from ${new Date(window.sentAt).toISOString()} to ${new Date(window.receivedAt).toISOString()} by this machine's clock`,
    };
  }
  if (payload.current !== true) {
    // CounterAudit's own words, printed for the operator: only a plain reason name is shown.
    const reason = typeof payload.reason === "string" && /^[a-z_]{1,40}$/.test(payload.reason) ? payload.reason : "no reason given";
    return {
      ok: false,
      problem: `CounterAudit does not attest its newest checkpoint as ${of}'s head (${reason})`,
      retry: reason === "tip_moved",
    };
  }
  const issuedAt = typeof payload.checkpoint_issued_at === "string" ? Date.parse(payload.checkpoint_issued_at) : NaN;
  const same = head
    ? payload.tip_sequence === head.sequence &&
      payload.checkpoint_sequence === head.sequence &&
      payload.checkpoint_entry_hash === head.entryHash &&
      payload.checkpoint_packet_id === head.packetId &&
      issuedAt === head.issuedAt.getTime()
    : payload.tip_sequence === null &&
      payload.checkpoint_sequence === null &&
      payload.checkpoint_entry_hash === null &&
      payload.checkpoint_packet_id === null &&
      payload.checkpoint_issued_at === null;
  if (!same) {
    return { ok: false, problem: `${of}'s head attestation names another head than the checkpoint in the same answer` };
  }
  return null;
}

/** "sequence:entryhash", as COUNTERAUDIT_REVIEW_MIN_HEAD gives a head someone already holds. */
export function parseHead(text: string): Head | null {
  const match = /^(\d+):([0-9a-f]{64})$/.exec(text.trim());
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? { sequence, entryHash: match[2] } : null;
}

export type ReadResult = {
  // Packets to store, in sequence order, each linked to the one before.
  rows: InsertReviewLogRecord[];
  // How many packets CounterAudit listed for the organization (as far as the listing got), so a
  // caller can tell whether what it holds after storing the rows is the whole log.
  listed: number;
  // Whether the listing reached its end, so `listed` is the whole count.
  listedComplete: boolean;
  // Why reading stopped early, or null.
  problem: string | null;
  // CounterAudit's signed checkpoint for the log, when its signature checked out and the log read
  // holds no other packet at its sequence; given with a problem too, so the caller can record it
  // and the next read must reach it. Null when none was read, it failed, or the log contradicts it.
  checkpoint: Checkpoint | null;
};

/** Why this organization's review log may not be read, or null: only the pinned one may. */
export function pinnedOrgProblem(orgId: string): string | null {
  return orgId === REVIEW_ORG_ID
    ? null
    : `organization ${orgId} is not the review organization pinned in server/reviewLog.ts (REVIEW_ORG_ID)`;
}

/**
 * Reads the review organization's packets that `known` does not hold yet. Every packet's body
 * comes from CounterAudit's verify route, which checks the packet's seal and hashes; this checks
 * the organization, and that each packet's sequence and previous hash follow the one before it.
 * The log read must then reach CounterAudit's signed checkpoint, and `minHead`, a head the caller
 * already holds, when it gives one: a log that ends short of either is a problem, not a shorter log.
 */
export async function readReviewLog(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  known: ReviewLogRecordRow[];
  minHead?: Head | null;
  fetch?: Fetch;
  now?: Date;
}): Promise<ReadResult> {
  const notPinned = pinnedOrgProblem(options.orgId);
  if (notPinned) return { rows: [], listed: 0, listedComplete: false, problem: notPinned, checkpoint: null };
  const fetchImpl = options.fetch ?? fetch;
  const base = counterauditBase(options.apiUrl);
  const now = options.now ?? new Date();
  const knownIds = new Set(options.known.map(r => r.packetId));

  // CounterAudit's signed checkpoint, read before the listing, which is read past CounterAudit's
  // short cache of it: every packet the checkpoint covers is then listed, and one sealed between
  // the two only makes the listing longer. It is checked once the chain is (below).
  const checkpoint = await readCheckpoint({ ...options, fetch: fetchImpl });
  const shown = checkpoint.ok ? checkpoint.head : checkpoint.checkpoint;
  // Whether packets already read hold another packet at the checkpoint's sequence; then it is not
  // returned to be recorded.
  const contradicted = (held: Array<{ sequence: number; entryHash: string; packetId: string }>) =>
    shown !== null &&
    held.some(r => r.sequence === shown.sequence && (r.entryHash !== shown.entryHash || r.packetId !== shown.packetId));
  const recordable = (held: Array<{ sequence: number; entryHash: string; packetId: string }>) =>
    contradicted(held) ? null : shown;

  // Every packet id, newest first.
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      return { rows: [], listed: ids.length, listedComplete: false, problem: "the review log has more packets than one sync reads", checkpoint: recordable(options.known) };
    }
    const query = new URLSearchParams({ limit: String(PAGE), refresh: "1", ...(cursor ? { cursor } : {}) });
    const listed = await call(fetchImpl, `${base}/v1/audit/packets?${query}`, options.readKey);
    if (listed.status !== 200 || !isRecord(listed.body) || !Array.isArray(listed.body.packets)) {
      return {
        rows: [],
        listed: ids.length,
        listedComplete: false,
        problem: `CounterAudit answered ${listed.status} when listing the review log's packets`,
        checkpoint: recordable(options.known),
      };
    }
    for (const p of listed.body.packets) {
      if (isRecord(p) && typeof p.packet_id === "string" && UUID.test(p.packet_id)) ids.push(p.packet_id);
    }
    const next = listed.body.next_cursor;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }

  // From here the listing is whole: every answer below carries it.
  const fresh: InsertReviewLogRecord[] = [];
  const done = (
    rows: InsertReviewLogRecord[],
    problem: string | null,
    checkpoint: Checkpoint | null = recordable([...options.known, ...fresh])
  ): ReadResult => ({ rows, listed: ids.length, listedComplete: true, problem, checkpoint });
  for (const id of ids) {
    if (knownIds.has(id)) continue;
    const got = await call(fetchImpl, `${base}/v1/audit/verify/${id}`, options.readKey);
    if (got.status === 410) {
      return done([], `packet ${id} has been erased; the review log must keep every packet`);
    }
    const body = got.body;
    if (got.status !== 200 || !isRecord(body) || body.valid !== true || !isRecord(body.packet)) {
      return done([], `CounterAudit could not verify packet ${id} (${got.status})`);
    }
    const packet = body.packet;
    const integrity = isRecord(packet.integrity) ? packet.integrity : {};
    if (packet.org_id !== options.orgId) {
      return done([], `packet ${id} belongs to another organization`);
    }
    if (packet.packet_id !== id) {
      return done([], `CounterAudit answered for another packet than ${id}`);
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
      return done([], `packet ${id} is missing its sequence, hashes or time`);
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
    return done([], `the review log does not start at sequence 0 (its first packet is ${all[0].sequence})`);
  }
  const rows: InsertReviewLogRecord[] = [];
  for (let i = 0; i < all.length; i++) {
    const row = all[i];
    const before = all[i - 1];
    if (before && (row.sequence !== before.sequence + 1 || row.prevHash !== before.entryHash)) {
      return done(
        rows,
        row.sequence === before.sequence
          ? `two packets claim sequence ${row.sequence}`
          : `the chain breaks between sequence ${before.sequence} and ${row.sequence}; read up to ${before.sequence}`
      );
    }
    if (row.isNew) {
      const { isNew: _isNew, ...stored } = row;
      rows.push(stored);
    }
  }

  if (!checkpoint.ok) return done(rows, checkpoint.problem);
  const cp = checkpoint.head;
  // CounterAudit issues a checkpoint for any chain with a numbered packet, so "none yet" for a log
  // that lists packets is an endpoint hiding it, or one without the route (review AB-01).
  if (!cp && all.length > 0) {
    return done(rows, "CounterAudit gives no signed checkpoint for a review log it lists packets in");
  }
  const minHead = options.minHead ?? null;
  if (cp && minHead && cp.sequence < minHead.sequence) {
    return done(
      rows,
      `CounterAudit's signed checkpoint is at sequence ${cp.sequence}, below sequence ${minHead.sequence}, which the review log has already reached: its head went back`,
      cp
    );
  }
  const atSequence = new Map(all.map(r => [r.sequence, r]));
  const tip = all.length > 0 ? all[all.length - 1].sequence : null;
  for (const [what, head] of [
    ["CounterAudit's signed checkpoint", cp],
    ["the head already reached", minHead],
  ] as const) {
    if (!head) continue;
    const found = atSequence.get(head.sequence);
    if (found === undefined) {
      return done(
        rows,
        `${what} is at sequence ${head.sequence}, but the log read ends ${tip === null ? "before sequence 0" : `at sequence ${tip}`}: it is not the whole log`,
        cp
      );
    }
    if (found.entryHash !== head.entryHash || ("packetId" in head && found.packetId !== head.packetId)) {
      // Nothing is recorded over a contradiction: it would hide the head that shows it.
      return done(rows, `${what} names another packet at sequence ${head.sequence} than the log read holds`, null);
    }
  }
  return done(rows, null, cp);
}

/**
 * One review-log packet as CounterAudit's verify route returns it, for a reader checking a
 * file's review-log references (pnpm file verify). CounterAudit checks the packet's seal and
 * hashes; this returns where it sits and the signed record it holds.
 */
export async function readReviewPacket(
  packetId: string,
  options: { apiUrl: string; readKey: string; fetch?: Fetch }
): Promise<
  | { ok: true; orgId: unknown; sequence: unknown; entryHash: unknown; record: unknown }
  | { ok: false; reason: string }
> {
  if (!UUID.test(packetId)) return { ok: false, reason: "not a packet id" };
  const got = await call(
    options.fetch ?? fetch,
    `${counterauditBase(options.apiUrl)}/v1/audit/verify/${packetId}`,
    options.readKey
  );
  const body = got.body;
  if (got.status !== 200 || !isRecord(body) || body.valid !== true || !isRecord(body.packet)) {
    return { ok: false, reason: `CounterAudit could not verify it (${got.status})` };
  }
  const packet = body.packet;
  const integrity = isRecord(packet.integrity) ? packet.integrity : {};
  return {
    ok: true,
    orgId: packet.org_id,
    sequence: packet.sequence,
    entryHash: integrity.entry_hash,
    record: packet.connector_id === REVIEW_CONNECTOR_ID ? packet.signed_event : null,
  };
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
