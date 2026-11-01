// Brings stored lines' display states in line with what acts on them: the
// furnisher's later relations (docs/line-states.md) and the reviewers' signed
// decisions in the independent review log (docs/review-log-design.md). Used by
// the intake and by pnpm review.
import type { ReviewLogRecordRow } from "../drizzle/schema";
import {
  findRelatingOutcomeLines,
  getOutcomeLine,
  insertReviewLogRecords,
  listReviewLogRecords,
  setOutcomeEventDisplayState,
} from "./db";
import { checkLineDisputes, disputeOf } from "./dispute";
import {
  displayStateFor,
  lineStates,
  relationProblem,
  type DisplayState,
  type Line,
  type Review,
} from "./lineState";
import { replayReviewLog, type ReviewLog } from "./reviewLog";
import { readReviewLog, type Fetch } from "./reviewLogSync";

const MAX_RELATION_HOPS = 10;

/** The stored packets linked from sequence 0, up to the first missing or out of place. */
function linkedRecords(rows: ReviewLogRecordRow[]): ReviewLogRecordRow[] {
  const linked: ReviewLogRecordRow[] = [];
  for (const row of rows) {
    const before = linked.at(-1);
    const follows = before
      ? row.sequence === before.sequence + 1 && row.prevHash === before.entryHash
      : row.sequence === 0;
    if (!follows) break;
    linked.push(row);
  }
  return linked;
}

/**
 * The review log as stored by pnpm review sync, with its rules applied. Only
 * what reviewers sealed there counts; nothing the operator hands over does.
 * Only the run of packets linked from sequence 0 is read: a stored packet
 * missing or out of place stops it there, as a gap stops pnpm review sync.
 */
export async function loadReviewLog(): Promise<ReviewLog> {
  return replayLinked(linkedRecords(await listReviewLogRecords()));
}

/** Where the review log stood when a decision was taken from it: its newest packet. */
export type ReviewLogPosition = { sequence: number; entryHash: string; packetId: string };

/**
 * Brings the stored review log up to CounterAudit's head and loads it, for a release
 * (pnpm file assemble). Anything short of the whole log is a problem, never a shorter
 * log: a rejection sealed since the last pnpm review sync must not be missed.
 */
export async function loadCurrentReviewLog(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  fetch?: Fetch;
  now?: Date;
}): Promise<{ log: ReviewLog; position: ReviewLogPosition | null } | { problem: string }> {
  const read = await readReviewLog({ ...options, known: await listReviewLogRecords() });
  if (read.problem) return { problem: read.problem };
  await insertReviewLogRecords(read.rows);
  const stored = await listReviewLogRecords();
  const linked = linkedRecords(stored);
  if (linked.length !== stored.length) {
    const last = linked.at(-1);
    return { problem: `the stored review log breaks after ${last ? `sequence ${last.sequence}` : "its start"}` };
  }
  if (stored.length !== read.listed) {
    return { problem: `the Bureau holds ${stored.length} review-log packets and CounterAudit lists ${read.listed}` };
  }
  const tip = linked.at(-1);
  return {
    log: replayLinked(linked),
    position: tip ? { sequence: tip.sequence, entryHash: tip.entryHash, packetId: tip.packetId } : null,
  };
}

/**
 * The whole review log as CounterAudit holds it now, read and replayed without the Bureau's
 * database, for checking a file still stands (pnpm file verify --current). Anything short of the
 * whole log, linked from sequence 0, is a problem, as for loadCurrentReviewLog.
 */
export async function readReviewLogNow(options: {
  apiUrl: string;
  readKey: string;
  orgId: string;
  fetch?: Fetch;
  now?: Date;
}): Promise<
  | { log: ReviewLog; rows: ReviewLogRecordRow[]; position: ReviewLogPosition | null }
  | { problem: string }
> {
  const read = await readReviewLog({ ...options, known: [] });
  if (read.problem) return { problem: read.problem };
  if (!read.listedComplete) return { problem: "CounterAudit's listing of the review log did not reach its end" };
  const rows = read.rows as ReviewLogRecordRow[];
  const linked = linkedRecords(rows);
  if (linked.length !== rows.length || rows.length !== read.listed) {
    return { problem: `CounterAudit lists ${read.listed} review-log packets, and ${linked.length} of them link from the start` };
  }
  const tip = linked.at(-1);
  return {
    log: replayLinked(linked),
    rows: linked,
    position: tip ? { sequence: tip.sequence, entryHash: tip.entryHash, packetId: tip.packetId } : null,
  };
}

function replayLinked(linked: ReviewLogRecordRow[]): ReviewLog {
  return replayReviewLog(
    linked.map(row => {
      // A MariaDB server older than 10.5.2 returns the JSON column as text.
      let record: unknown = row.record;
      if (typeof record === "string") {
        try {
          record = JSON.parse(record);
        } catch {
          record = null;
        }
      }
      return { sequence: row.sequence, packetId: row.packetId, sealedAt: new Date(row.sealedAt), record };
    })
  );
}

/** The decisions on this line that the review log counts, and those that hold it. */
export function reviewsFor(line: Line, log: ReviewLog): Review[] {
  return log.decisions
    .filter(d => d.decision.furnisher_id === line.furnisherId && d.decision.event_id === line.eventId)
    .map(d => ({
      id: d.sequence,
      reviewerId: d.decision.reviewer_id,
      decision: d.decision.decision,
      signedEventHash: d.decision.signed_event_hash,
      dataClass: d.decision.data_class,
      evidenceDigest: d.decision.evidence_digest,
      decidedAt: new Date(d.decision.decided_at),
      suspended: d.suspended,
      packetId: d.packetId,
      sealedAt: d.sealedAt,
    }));
}

// Recomputes one line's display state from the relations acting on it, the
// review log's decisions and the subject's dispute on it as of now, its records
// checked again, and stores it if it changed. Returns the new state, or null if
// unchanged.
export async function settle(
  line: Line,
  log?: ReviewLog,
  now: Date = new Date()
): Promise<DisplayState | null> {
  const relating = await findRelatingOutcomeLines(
    line.furnisherId,
    line.eventId
  );
  const reviewLog = log ?? (await loadReviewLog());
  const reviews = reviewsFor(line, reviewLog);
  const dispute = disputeOf(
    await checkLineDisputes(line),
    relating,
    l => reviewsFor(l, reviewLog),
    now
  );
  const state = displayStateFor(
    lineStates(line, relating, reviews, dispute?.state ?? null)
  );
  if (state === line.displayState) return null;
  await setOutcomeEventDisplayState(line.id, state);
  return state;
}

// Brings this line, and the line its relation points at, in line with the
// relations that act on them. A relation may arrive before its target, so a
// line's own state is settled too. Returns notes for the report.
export async function settleDisplayStates(
  furnisherId: string,
  eventId: string
): Promise<string[]> {
  const line = await getOutcomeLine(furnisherId, eventId);
  if (!line) return [];
  const log = await loadReviewLog();
  const notes: string[] = [];
  const own = await settle(line, log);
  if (own) notes.push(`now shown as ${own}`);
  const targetId = line.relationTargetEventId;
  if (!line.relationType || !targetId) return notes;

  const label = `${line.relationType} ${targetId}`;
  const target = await getOutcomeLine(furnisherId, targetId);
  if (!target) {
    notes.push(
      `${label}: ${furnisherId} has no such line yet; it takes effect when that line is stored`
    );
    return notes;
  }
  // Settled whether or not the relation applies: one that applied before and
  // no longer does (its proof failed on a re-run) must stop acting.
  const problem = relationProblem(line, target);
  const changed = await settle(target, log);
  const outcome = problem ? `not applied, ${problem}` : "applied";
  notes.push(
    changed
      ? `${label}: ${outcome}; that line is now ${changed}`
      : `${label}: ${outcome}`
  );

  // A withdrawn dispute stops acting, so a change can carry on along the
  // chain of relations. Bounded, in case a furnisher's relations loop.
  let current = target;
  for (
    let hop = 0;
    changed && hop < MAX_RELATION_HOPS && current.relationTargetEventId;
    hop++
  ) {
    const next = await getOutcomeLine(
      furnisherId,
      current.relationTargetEventId
    );
    if (!next) break;
    const nextChanged = await settle(next, log);
    if (!nextChanged) break;
    notes.push(
      `${current.relationType} ${next.eventId} by ${current.eventId}: that line is now ${nextChanged}`
    );
    current = next;
  }
  return notes;
}
