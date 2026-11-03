// Evidence seals (the owner's decision, 2026-11-02): each evidence result the intake stores is
// also sealed in CounterAudit, in the Bureau's own organization, through the
// agent-bureau-evidence-v1 connector. Reviewers' decisions name the digest of the result they
// saw, and the intake overwrites a line's result with no history, so someone who could write the
// Bureau's rows could put back an older result reviewers once approved. CounterAudit's chain is
// append-only: a file counts approvals only against the result sealed last for its line.
import { EVIDENCE_STATUSES } from "../drizzle/schema";
import type { EvidenceResult } from "./evidence";
import { needsWaiver } from "./lineState";
import { isRecord } from "./outcomeProof";
import { evidenceDigest } from "./reviewDecision";
import { call, counterauditBase, readCheckpoint, type Fetch } from "./reviewLogSync";

export const EVIDENCE_SCHEMA = "agent-bureau/evidence-result/v1";
export const EVIDENCE_CONNECTOR_ID = "agent-bureau-evidence-v1";

const FURNISHER_ID = /^fur_[a-z0-9]{6,32}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 100;
const MAX_PAGES = 1000;
const FIELDS = [
  "schema",
  "furnisher_id",
  "event_id",
  "signed_event_hash",
  "evidence_digest",
  "status",
  "needs_waiver",
  "checked_at",
] as const;

/**
 * One sealed evidence result: the line it is for (furnisher, event and the version reviewers
 * sign), the digest of the result as reviewers' decisions name it, its status, whether an
 * approval must waive something for it, and when the intake checked it. Nothing of the result
 * itself, which can name wallets.
 */
export type EvidenceRecord = {
  schema: typeof EVIDENCE_SCHEMA;
  furnisher_id: string;
  event_id: string;
  signed_event_hash: string;
  evidence_digest: string;
  status: (typeof EVIDENCE_STATUSES)[number];
  needs_waiver: boolean;
  checked_at: string;
};

/** The record's form, exactly as CounterAudit's connector checks it. */
export function checkEvidenceRecord(
  value: unknown
): { ok: true; record: EvidenceRecord } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!isRecord(value)) return fail("not a JSON object");
  const extra = Object.keys(value).filter(k => !(FIELDS as readonly string[]).includes(k));
  if (extra.length > 0) return fail(`unknown field ${extra[0]}`);
  const missing = FIELDS.filter(k => !Object.hasOwn(value, k));
  if (missing.length > 0) return fail(`${missing[0]} is missing`);
  if (value.schema !== EVIDENCE_SCHEMA) return fail(`schema is not ${EVIDENCE_SCHEMA}`);
  const text = (k: string, pattern: RegExp, hint: string) =>
    typeof value[k] === "string" && pattern.test(value[k] as string) ? null : `${k} is not ${hint}`;
  const checkedAt =
    typeof value.checked_at === "string" && TIME.test(value.checked_at)
      ? new Date(value.checked_at)
      : null;
  const problem =
    text("furnisher_id", FURNISHER_ID, "a furnisher id (fur_...)") ??
    text("event_id", EVENT_ID, "an event id") ??
    text("signed_event_hash", HASH, "64 lowercase hex characters") ??
    text("evidence_digest", HASH, "64 lowercase hex characters") ??
    ((EVIDENCE_STATUSES as readonly unknown[]).includes(value.status)
      ? null
      : `status is not one of ${EVIDENCE_STATUSES.join(", ")}`) ??
    (typeof value.needs_waiver === "boolean" ? null : "needs_waiver is not true or false") ??
    (checkedAt && Number.isFinite(checkedAt.getTime()) && checkedAt.toISOString() === value.checked_at
      ? null
      : "checked_at is not a UTC time with milliseconds");
  return problem ? fail(problem) : { ok: true, record: value as EvidenceRecord };
}

/** The record the intake seals for a line's evidence result, as it stores it. */
export function evidenceRecordFor(
  line: { furnisherId: string; eventId: string; signedEventHash: string },
  result: EvidenceResult,
  checkedAt: Date
): EvidenceRecord {
  return {
    schema: EVIDENCE_SCHEMA,
    furnisher_id: line.furnisherId,
    event_id: line.eventId,
    signed_event_hash: line.signedEventHash,
    evidence_digest: evidenceDigest(result),
    status: result.status,
    needs_waiver: needsWaiver(result),
    checked_at: checkedAt.toISOString(),
  };
}

/** An evidence record as CounterAudit sealed it. */
export type SealedEvidence = { packetId: string; sequence: number; record: EvidenceRecord };

/**
 * The evidence result sealed last for each version of each line (by signed_event_hash), read
 * from the Bureau's organization with its read key.
 *
 * The read is held to CounterAudit's signed head for the organization, attested over a nonce made
 * for this read and read first (readCheckpoint), as the review log's is: a listing that leaves out
 * a newer seal, or calls it something else, could otherwise pass an older one off as the last
 * (review AB-01, as it applies to seals). Every listed packet, bypassing CounterAudit's short
 * cache of the list, is read through its verify route, which checks its seal, and its place,
 * hashes and connector are taken from there, not from the listing. Walking back from the head by
 * each packet's previous hash must then find every packet down to sequence 0, and every packet
 * must sit at its place in that walk or after the head.
 *
 * An erased packet's verify route answers 410 and gives nothing, so the listing's hashes stand in
 * for it, and the listing must say it is erased only of a packet the verify route agrees is.
 * Erased seals are left out, but only while each is below every seal still held, as when the
 * retention policy erases the oldest first: otherwise an older seal could stand in for a newer one
 * that was erased, so nothing is read. Anything else that cannot be read stops the reading too.
 */
export async function readEvidenceSeals(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  fetch?: Fetch;
}): Promise<{ seals: Map<string, SealedEvidence> } | { problem: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const base = counterauditBase(options.apiUrl);
  const signed = await readCheckpoint({ ...options, fetch: fetchImpl, of: "the Bureau organization" });
  if (!signed.ok) return { problem: signed.problem };
  const head = signed.head;

  // Every packet id, with what the listing says of it, used only for an erased packet.
  const listed: { id: string; erased: boolean; connector: unknown; prevHash: unknown; entryHash: unknown }[] = [];
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) return { problem: "the organization has more packets than one read lists" };
    const query = new URLSearchParams({ limit: String(PAGE), refresh: "1", ...(cursor ? { cursor } : {}) });
    const got = await call(fetchImpl, `${base}/v1/audit/packets?${query}`, options.readKey);
    if (got.status !== 200 || !isRecord(got.body) || !Array.isArray(got.body.packets)) {
      return { problem: `CounterAudit answered ${got.status} when listing the organization's packets` };
    }
    for (const p of got.body.packets) {
      if (!isRecord(p) || typeof p.packet_id !== "string" || !UUID.test(p.packet_id)) {
        return { problem: "CounterAudit listed a packet without a packet id" };
      }
      listed.push({
        id: p.packet_id,
        erased: Boolean(p.expired_at),
        connector: p.connector_id,
        prevHash: p.prev_hash,
        entryHash: p.entry_hash,
      });
    }
    const next = got.body.next_cursor;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }

  // Each packet as the verify route gives it, by entry hash.
  type Node = {
    id: string;
    prevHash: string;
    entryHash: string;
    connector: unknown;
    // null for an erased packet, which gives none, and for one from before CounterAudit numbered packets.
    sequence: number | null;
    erased: boolean;
    record?: unknown;
  };
  const byEntryHash = new Map<string, Node>();
  const seenIds = new Set<string>();
  for (const p of listed) {
    if (seenIds.has(p.id)) return { problem: `CounterAudit listed packet ${p.id} twice` };
    seenIds.add(p.id);
    const got = await call(fetchImpl, `${base}/v1/audit/verify/${p.id}`, options.readKey);
    let node: Node;
    if (got.status === 410) {
      if (typeof p.prevHash !== "string" || !HASH.test(p.prevHash) || typeof p.entryHash !== "string" || !HASH.test(p.entryHash)) {
        return { problem: `CounterAudit listed erased packet ${p.id} without its hashes` };
      }
      node = { id: p.id, prevHash: p.prevHash, entryHash: p.entryHash, connector: p.connector, sequence: null, erased: true };
    } else {
      if (p.erased) return { problem: `CounterAudit lists packet ${p.id} as erased, but its verify route holds it` };
      const body = got.body;
      if (got.status !== 200 || !isRecord(body) || body.valid !== true || !isRecord(body.packet)) {
        return { problem: `CounterAudit could not verify packet ${p.id} (${got.status})` };
      }
      const packet = body.packet;
      const integrity = isRecord(packet.integrity) ? packet.integrity : {};
      if (packet.packet_id !== p.id || packet.org_id !== options.orgId) {
        return { problem: `packet ${p.id} is not a packet of the Bureau's organization` };
      }
      const sequence = packet.sequence;
      const isEvidence = packet.connector_id === EVIDENCE_CONNECTOR_ID;
      if (
        !(sequence === null || sequence === undefined || (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0)) ||
        (isEvidence && typeof sequence !== "number")
      ) {
        return { problem: `${isEvidence ? "evidence packet" : "packet"} ${p.id} has no sequence` };
      }
      if (typeof integrity.prev_hash !== "string" || !HASH.test(integrity.prev_hash) || typeof integrity.entry_hash !== "string" || !HASH.test(integrity.entry_hash)) {
        return { problem: `packet ${p.id} is missing its hashes` };
      }
      node = {
        id: p.id,
        prevHash: integrity.prev_hash,
        entryHash: integrity.entry_hash,
        connector: packet.connector_id,
        sequence: typeof sequence === "number" ? sequence : null,
        erased: false,
        record: packet.signed_event,
      };
    }
    if (byEntryHash.has(node.entryHash)) return { problem: `two packets CounterAudit lists share entry hash ${node.entryHash}` };
    byEntryHash.set(node.entryHash, node);
  }

  // Walk back from the signed head to sequence 0: a packet left out breaks the walk. An erased
  // packet's hashes come from the listing, and the verified packets on either side hold them.
  const placed = new Map<string, number>();
  if (head) {
    let at = head.entryHash;
    for (let sequence = head.sequence; sequence >= 0; sequence--) {
      const node = byEntryHash.get(at);
      if (!node || (sequence === head.sequence && node.id !== head.packetId)) {
        return {
          problem: `CounterAudit's listing of the Bureau organization's packets leaves out sequence ${sequence}, at or below its signed head at sequence ${head.sequence}`,
        };
      }
      placed.set(node.id, sequence);
      at = node.prevHash;
    }
  }
  // Every numbered packet at its place in the walk, or sealed after the head was read.
  for (const node of byEntryHash.values()) {
    if (node.sequence === null) continue;
    const place = placed.get(node.id);
    if (place !== undefined ? node.sequence !== place : head !== null && node.sequence <= head.sequence) {
      return {
        problem: `packet ${node.id} says it is at sequence ${node.sequence}, which is not its place in the chain to CounterAudit's signed head`,
      };
    }
  }

  const seals = new Map<string, SealedEvidence>();
  const held: number[] = [];
  let newestErased = -Infinity;
  for (const node of byEntryHash.values()) {
    if (node.erased) {
      // An erased packet's connector is the listing's word; its place is the walk's.
      if (node.connector === EVIDENCE_CONNECTOR_ID) newestErased = Math.max(newestErased, placed.get(node.id) ?? Infinity);
      continue;
    }
    if (node.connector !== EVIDENCE_CONNECTOR_ID) continue;
    const sequence = node.sequence as number;
    const form = checkEvidenceRecord(node.record);
    if (!form.ok) return { problem: `evidence packet ${node.id} does not hold an evidence record: ${form.reason}` };
    const seen = seals.get(form.record.signed_event_hash);
    if (!seen || sequence > seen.sequence) {
      seals.set(form.record.signed_event_hash, { packetId: node.id, sequence, record: form.record });
    }
    held.push(sequence);
  }
  if (held.some(sequence => sequence < newestErased)) {
    return {
      problem:
        "CounterAudit erased an evidence seal newer than one it still holds, so the seal held for a line may not be its last",
    };
  }
  return { seals };
}

/**
 * The seal that counts for a line: the latest for its signed event, naming its furnisher and
 * event. Undefined when there is none.
 */
export function sealFor(
  seals: Map<string, SealedEvidence>,
  line: { furnisherId: string; eventId: string; signedEventHash: string }
): SealedEvidence | undefined {
  const seal = seals.get(line.signedEventHash);
  return seal && seal.record.furnisher_id === line.furnisherId && seal.record.event_id === line.eventId
    ? seal
    : undefined;
}
