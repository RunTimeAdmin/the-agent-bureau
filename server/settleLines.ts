// Brings stored lines' display states in line with what acts on them: the
// furnisher's later relations (docs/line-states.md) and the listed reviewers'
// signed decisions (docs/two-person-review.md). Used by the intake and by
// pnpm review.
import {
  findRelatingOutcomeLines,
  getOutcomeLine,
  listReviewsForLine,
  setOutcomeEventDisplayState,
} from "./db";
import {
  displayStateFor,
  lineStates,
  relationProblem,
  type DisplayState,
  type Line,
  type Review,
} from "./lineState";
import {
  REVIEWERS,
  checkReviewDecision,
  type Reviewer,
} from "./reviewDecision";

const MAX_RELATION_HOPS = 10;

/**
 * The line's recorded decisions that still count: each one's signature is
 * checked again against the reviewers listed now, and everything is read from
 * the signed form. An edited row, a reviewer no longer listed, or a key since
 * replaced drops out.
 */
export async function reviewsFor(
  line: Line,
  reviewers: Record<string, Reviewer> = REVIEWERS
): Promise<Review[]> {
  const reviews: Review[] = [];
  for (const row of await listReviewsForLine(line.id)) {
    let signed = row.signedDecision;
    if (typeof signed === "string") {
      try {
        signed = JSON.parse(signed);
      } catch {
        continue;
      }
    }
    const checked = checkReviewDecision(signed, reviewers, null);
    if (!checked.ok) continue;
    const d = checked.decision;
    if (d.furnisher_id !== line.furnisherId || d.event_id !== line.eventId) {
      continue;
    }
    reviews.push({
      id: row.id,
      reviewerId: d.reviewer_id,
      decision: d.decision,
      signedEventHash: d.signed_event_hash,
      dataClass: d.data_class,
      evidenceDigest: d.evidence_digest,
      decidedAt: new Date(d.decided_at),
    });
  }
  return reviews;
}

// Recomputes one line's display state from the relations acting on it and
// the listed reviewers' decisions, and stores it if it changed. Returns the
// new state, or null if unchanged.
export async function settle(
  line: Line,
  reviewers: Record<string, Reviewer> = REVIEWERS
): Promise<DisplayState | null> {
  const relating = await findRelatingOutcomeLines(
    line.furnisherId,
    line.eventId
  );
  const reviews = await reviewsFor(line, reviewers);
  const state = displayStateFor(lineStates(line, relating, reviews));
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
  const notes: string[] = [];
  const own = await settle(line);
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
  const changed = await settle(target);
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
    const nextChanged = await settle(next);
    if (!nextChanged) break;
    notes.push(
      `${current.relationType} ${next.eventId} by ${current.eventId}: that line is now ${nextChanged}`
    );
    current = next;
  }
  return notes;
}
