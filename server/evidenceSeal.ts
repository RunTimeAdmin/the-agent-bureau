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
import { call, counterauditBase, type Fetch } from "./reviewLogSync";

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
 * from the Bureau's organization with its read key. Every packet is listed, bypassing
 * CounterAudit's short cache of the list; each evidence packet is read through its verify route,
 * which checks its seal. Erased packets are left out, but only while each is older than every
 * seal still held, as when the retention policy erases the oldest first: otherwise an older seal
 * could stand in for a newer one that was erased, so nothing is read. Anything else that cannot
 * be read stops the reading too.
 */
export async function readEvidenceSeals(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  fetch?: Fetch;
}): Promise<{ seals: Map<string, SealedEvidence> } | { problem: string }> {
  const fetchImpl = options.fetch ?? fetch;
  const base = counterauditBase(options.apiUrl);
  const ids: string[] = [];
  // When CounterAudit sealed each evidence packet, and the newest of those it erased.
  const sealedAt = new Map<string, number>();
  let newestErased = -Infinity;
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) return { problem: "the organization has more packets than one read lists" };
    const query = new URLSearchParams({ limit: String(PAGE), refresh: "1", ...(cursor ? { cursor } : {}) });
    const listed = await call(fetchImpl, `${base}/v1/audit/packets?${query}`, options.readKey);
    if (listed.status !== 200 || !isRecord(listed.body) || !Array.isArray(listed.body.packets)) {
      return { problem: `CounterAudit answered ${listed.status} when listing the organization's packets` };
    }
    for (const p of listed.body.packets) {
      if (isRecord(p) && p.connector_id === EVIDENCE_CONNECTOR_ID) {
        if (typeof p.packet_id !== "string" || !UUID.test(p.packet_id)) {
          return { problem: "CounterAudit listed an evidence packet without a packet id" };
        }
        const at = typeof p.created_at === "string" ? Date.parse(p.created_at) : Number.NaN;
        if (!Number.isFinite(at)) {
          return { problem: `CounterAudit listed evidence packet ${p.packet_id} without its time` };
        }
        sealedAt.set(p.packet_id, at);
        if (p.expired_at) newestErased = Math.max(newestErased, at);
        else ids.push(p.packet_id);
      }
    }
    const next = listed.body.next_cursor;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }
  const seals = new Map<string, SealedEvidence>();
  const held: number[] = [];
  for (const id of ids) {
    const got = await call(fetchImpl, `${base}/v1/audit/verify/${id}`, options.readKey);
    if (got.status === 410) {
      newestErased = Math.max(newestErased, sealedAt.get(id)!);
      continue;
    }
    const body = got.body;
    if (got.status !== 200 || !isRecord(body) || body.valid !== true || !isRecord(body.packet)) {
      return { problem: `CounterAudit could not verify evidence packet ${id} (${got.status})` };
    }
    const packet = body.packet;
    if (packet.org_id !== options.orgId || packet.connector_id !== EVIDENCE_CONNECTOR_ID) {
      return { problem: `packet ${id} is not an evidence record of the Bureau's organization` };
    }
    const sequence = packet.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
      return { problem: `evidence packet ${id} has no sequence` };
    }
    const form = checkEvidenceRecord(packet.signed_event);
    if (!form.ok) return { problem: `evidence packet ${id} does not hold an evidence record: ${form.reason}` };
    const seen = seals.get(form.record.signed_event_hash);
    if (!seen || sequence > seen.sequence) {
      seals.set(form.record.signed_event_hash, { packetId: id, sequence, record: form.record });
    }
    held.push(sealedAt.get(id)!);
  }
  if (held.some(at => at < newestErased)) {
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
