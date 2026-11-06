// Dispute records sealed in the Bureau's organization that the Bureau does not hold yet. Since
// review AB-02 (the CounterAudit route, chosen 2026-11-04) a line's subject or furnisher can send
// a signed record to CounterAudit themselves (POST /v1/public/disputes/:org_id), so the operator
// no longer decides whether one enters the log; the Bureau reads them back from its organization
// before it signs a file, and stores each as pnpm dispute submit would have.
import {
  findDisputeLine,
  getDisputeLine,
  insertDisputeRecord,
  listDisputeRecords,
  listStoredDisputes,
} from "./db";
import {
  checkDisputeForm,
  checkStoredRecord,
  lineSubject,
  readController,
  signedByWallet,
} from "./dispute";
import type { ErasedDispute, SealedDispute } from "./evidenceSeal";
import type { Furnisher } from "./furnishers";
import { canonicalizeJson } from "./outcomeProof";
import { RETENTION_MONTHS } from "./retention";
import type { SigvaraClient } from "./sigvaraStanding";

const sameJson = (a: unknown, b: unknown) => {
  try {
    return canonicalizeJson(a) === canonicalizeJson(b);
  } catch {
    return false;
  }
};

// A MariaDB server older than 10.5.2 returns JSON columns as text.
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type DisputeSyncResult = {
  /** Records stored now. */
  stored: number;
  /** Records sealed that submit would not have sealed; they count for nothing, and why. */
  refused: string[];
  /** Records about a line or dispute the Bureau does not hold yet; the next sync tries again. */
  waiting: string[];
  /** Where the store does not hold what CounterAudit sealed: no file is signed over it. */
  problems: string[];
};

// CounterAudit's own signed word: its retention job erased it, and it was sealed to be kept the full
// term, so a policy shortened to erase it sooner does not pass.
export const erasedByRetention = (e: ErasedDispute) =>
  e.kind === "scheduled" && typeof e.retentionMonths === "number" && e.retentionMonths >= RETENTION_MONTHS;

/**
 * Why the stored dispute records are not the ones CounterAudit sealed in the Bureau's
 * organization, one reason each, or none. Each stored record must sit at its packet's sequence and
 * seal time, hold the record sealed there (or nothing, once its line expired), and be stored on
 * the line it names, or its dispute's line. A stored record whose packet the organization does not
 * hold was never sealed. A dispute record CounterAudit erased must have gone with its line, or by
 * the retention policy: one erased while its line still stands could leave a dispute off a file
 * (review AB-02). Changed rows would otherwise decide what counts unseen, as an edited evidence
 * result would.
 */
function storeProblems(
  rows: Awaited<ReturnType<typeof listStoredDisputes>>,
  read: { disputes: SealedDispute[]; erasedDisputes: ErasedDispute[] }
): string[] {
  const problems: string[] = [];
  const sealedBy = new Map(read.disputes.map(d => [d.packetId, d]));
  const erasedBy = new Map(read.erasedDisputes.map(d => [d.packetId, d]));
  const rowBy = new Map(rows.map(r => [r.packetId, r]));
  // The line a dispute_id's first sealed dispute is stored on.
  const filingLine = new Map<string, number>();
  for (const r of [...rows].sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity))) {
    if (r.kind === "dispute" && !filingLine.has(r.disputeId)) filingLine.set(r.disputeId, r.outcomeEventId);
  }
  for (const row of rows) {
    const at = `stored dispute record ${row.packetId}`;
    const sealed = sealedBy.get(row.packetId);
    if (!sealed) {
      if (!erasedBy.has(row.packetId)) problems.push(`${at} names a packet the Bureau's organization does not hold`);
      continue;
    }
    if (row.sequence !== sealed.sequence || new Date(row.sealedAt).getTime() !== sealed.sealedAt.getTime()) {
      problems.push(`${at} is not at the sequence and seal time CounterAudit gives it`);
      continue;
    }
    const record = parsed(row.record);
    if (record === null || record === undefined) {
      if (!row.lineExpiredAt) problems.push(`${at} holds no record, though its line has not expired`);
      continue;
    }
    if (!sameJson(record, sealed.record)) {
      problems.push(`${at} is not the record CounterAudit sealed`);
      continue;
    }
    const line = (record as { line?: { furnisher_id?: unknown; event_id?: unknown; signed_event_hash?: unknown } }).line;
    if (
      row.kind === "dispute"
        ? line?.furnisher_id !== row.lineFurnisherId ||
          line?.event_id !== row.lineEventId ||
          line?.signed_event_hash !== row.lineSignedEventHash
        : filingLine.has(row.disputeId) && filingLine.get(row.disputeId) !== row.outcomeEventId
    ) {
      problems.push(`${at} is stored on another line than the one its dispute names`);
    }
  }
  for (const e of read.erasedDisputes) {
    if (rowBy.get(e.packetId)?.lineExpiredAt || erasedByRetention(e)) continue;
    problems.push(`CounterAudit erased dispute packet ${e.packetId} before its line expired or its retention ran out`);
  }
  return problems;
}

/**
 * Holds the stored dispute records to what CounterAudit sealed (storeProblems), then stores each
 * sealed dispute record the Bureau does not hold, in the order CounterAudit sealed them, checked
 * as pnpm dispute submit checks one: its form, the line it names (exactly, at the
 * version held, not expired, with the line's subject_ref) or the dispute it answers, a dispute_id
 * not used before, and then its signature and, for the subject's, control of the subject (the
 * agent address read from SigvaraIdentity now, for a did:sigvara). One submit would have refused
 * is not stored and counts for nothing; one that fails its checks is stored with what they found
 * and counts for nothing, as a submitted one does. Whether a stored record comes in its turn is
 * decided by seal time when disputes are derived (deriveDisputes). Throws when the database or
 * Sigvara cannot be read, so nothing signs on a part of the log.
 */
export async function storeSealedDisputes(
  read: { disputes: SealedDispute[]; erasedDisputes: ErasedDispute[] },
  deps: { sigvara: SigvaraClient; furnishers: Record<string, Furnisher> }
): Promise<DisputeSyncResult> {
  const rows = await listStoredDisputes();
  const result: DisputeSyncResult = { stored: 0, refused: [], waiting: [], problems: storeProblems(rows, read) };
  const held = new Set(rows.map(r => r.packetId));
  for (const s of [...read.disputes].sort((a, b) => a.sequence - b.sequence)) {
    if (held.has(s.packetId)) continue;
    const form = checkDisputeForm(s.record);
    if (!form.ok) {
      result.refused.push(`packet ${s.packetId}: ${form.reason}`);
      continue;
    }
    const record = form.record;
    const at = `packet ${s.packetId} (${record.kind} of dispute ${record.dispute_id})`;
    const stored = await listDisputeRecords(record.dispute_id);
    let line: Awaited<ReturnType<typeof findDisputeLine>>;
    if (record.kind === "dispute") {
      if (stored.some(r => r.kind === "dispute")) {
        result.refused.push(`${at}: the dispute_id was used by a dispute sealed before`);
        continue;
      }
      const { furnisher_id, event_id, signed_event_hash } = record.line;
      line = await findDisputeLine(furnisher_id, event_id);
      if (!line) {
        result.waiting.push(`${at}: the Bureau holds no line ${furnisher_id}/${event_id} yet`);
        continue;
      }
      if (line.signedEventHash !== signed_event_hash) {
        result.refused.push(`${at}: it names another version of ${furnisher_id}/${event_id} than the Bureau holds`);
        continue;
      }
      if (line.expiredAt) {
        result.refused.push(`${at}: ${furnisher_id}/${event_id} expired with its source`);
        continue;
      }
      if (!sameJson(parsed(lineSubject(line)), record.subject_ref)) {
        result.refused.push(`${at}: subject_ref is not exactly the line's`);
        continue;
      }
    } else {
      const filing = stored.find(r => r.kind === "dispute");
      if (!filing) {
        result.waiting.push(`${at}: the Bureau holds no dispute ${record.dispute_id} yet`);
        continue;
      }
      line = await getDisputeLine(filing.outcomeEventId);
      if (!line || line.expiredAt) {
        result.refused.push(`${at}: the line of the dispute is ${line ? "expired with its source" : "not held"}`);
        continue;
      }
    }

    const subject = parsed(lineSubject(line));
    let controller: string | null = null;
    let unread: string | null = null;
    if (signedByWallet(record)) {
      const control = await readController(subject, deps.sigvara, record.signer.address);
      controller = control?.controller ?? null;
      unread = control && !control.ok ? control.problem : null;
    }
    const check = await checkStoredRecord(
      { disputeId: record.dispute_id, kind: record.kind, record, controllerAddress: controller },
      { furnisherId: line.furnisherId, subjectRef: subject, signedEvent: line.signedEvent, receipt: line.receipt },
      deps.furnishers,
      { activeKeysOnly: true }
    );
    const problems = [
      ...(check.problem ? [check.problem] : []),
      ...(unread && check.subjectControlOk === false ? [unread] : []),
    ];
    // The receipt went to whoever sent the record; CounterAudit gives none to a reader.
    const added = await insertDisputeRecord({
      disputeId: record.dispute_id,
      kind: record.kind,
      outcomeEventId: line.id,
      record,
      packetId: s.packetId,
      sequence: s.sequence,
      sealedAt: s.sealedAt,
      receipt: null,
      signatureOk: check.signatureOk,
      subjectControlOk: check.subjectControlOk,
      checkProblem: problems.length ? problems.join("; ").slice(0, 500) : null,
      controllerAddress: controller,
    });
    if (added) {
      result.stored++;
      held.add(s.packetId);
    }
  }
  return result;
}
