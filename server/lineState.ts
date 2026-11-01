// What is known about a stored line, kept apart instead of folded into one
// "verified" bit (the 2026-10-31 review, proof contract): CounterAudit sealed
// it, the furnisher's signature checked out through CounterAudit's proof, its
// evidence passed, what later lines from the same furnisher did to it, and
// whether reviewers released it. See docs/line-states.md and
// docs/two-person-review.md.
import canonicalize from "canonicalize";
import type {
  DISPLAY_STATES,
  OutcomeEvent,
  RELATION_TYPES,
  REVIEW_DECISIONS,
} from "../drizzle/schema";
import type {
  CheckedDisputeRecord,
  DisputeState,
  StoredDisputeRecord,
} from "./dispute";
import { chargeKey, type LevyCharge } from "./evidence";
import { isRecord } from "./outcomeProof";
import { evidenceDigest } from "./reviewDecision";

export type DisplayState = (typeof DISPLAY_STATES)[number];
type RelationType = (typeof RELATION_TYPES)[number];

export type Line = Pick<
  OutcomeEvent,
  | "id"
  | "furnisherId"
  | "eventId"
  | "subjectRef"
  | "dataClass"
  | "proofOk"
  | "evidenceStatus"
  | "evidenceResult"
  | "evidenceKey"
  | "signedEventHash"
  | "displayState"
  | "relationType"
  | "relationTargetEventId"
> & {
  /** When CounterAudit sealed it: a relating line answers a subject dispute only if sealed before its deadline. */
  caCreatedAt?: Date | string;
  /** The subject disputes on the line (server/dispute.ts), when they were read with it. */
  disputeRecords?: StoredDisputeRecord[];
  /** Those records, each checked again (checkLineDisputes in server/dispute.ts). */
  checkedDisputes?: CheckedDisputeRecord[];
  /** The line's signed event and CounterAudit's receipt, which name the key that signed it. */
  signedEvent?: unknown;
  receipt?: unknown;
};

// A recorded decision, read from its re-checked signed form
// (server/settleLines.ts), never from the table's own columns.
export type Review = {
  id: number;
  reviewerId: string;
  decision: (typeof REVIEW_DECISIONS)[number];
  signedEventHash: string;
  dataClass: "test" | "live";
  evidenceDigest: string;
  decidedAt: Date;
  // By a reviewer the review log has suspended: it does not count, and it holds
  // its line until the other reviewers re-enable, rotate or remove them.
  suspended?: boolean;
  // The review-log packet that holds the decision, when it came from the review log.
  packetId?: string;
  // When CounterAudit sealed that packet: an appeal is decided by decisions sealed after it.
  sealedAt?: Date;
};

// How reviewers released a line: two different reviewers, or for test data
// one reviewer alone, which a file must label as such.
export type Release = "two_person" | "solo_test";

export type LineStates = {
  sealed: true;
  source_signed: boolean;
  evidence_verified: boolean;
  disputed: boolean;
  withdrawn: boolean;
  superseded: boolean;
  released: Release | null;
  // Only for a line with a subject dispute (docs/disputes.md): the dispute's
  // state, and whether it lapsed, which removes the line for good.
  subject_dispute?: DisputeState;
  removed?: boolean;
};

// A Sigvara DID: its chain id written plainly, then an EVM address.
const SIGVARA_DID =
  /^(did:sigvara:(?:0|[1-9][0-9]{0,11}):)(0x[0-9a-fA-F]{40})$/;

// EVM addresses compare without case, in a wallet or in a did:sigvara;
// everything else exactly. A MariaDB server older than 10.5.2 returns the
// JSON column as text, so parse it first.
export function subjectKey(stored: Record<string, unknown> | string): string {
  let subjectRef: unknown = stored;
  if (typeof stored === "string") {
    try {
      subjectRef = JSON.parse(stored);
    } catch {
      return stored;
    }
  }
  if (typeof subjectRef !== "object" || subjectRef === null) {
    return String(stored);
  }
  const { wallet, did } = subjectRef as Record<string, unknown>;
  const sigvara = typeof did === "string" ? SIGVARA_DID.exec(did) : null;
  const normalized =
    typeof wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(wallet)
      ? { ...subjectRef, wallet: wallet.toLowerCase() }
      : sigvara
        ? { ...subjectRef, did: `${sigvara[1]}${sigvara[2].toLowerCase()}` }
        : subjectRef;
  return canonicalize(normalized) ?? "";
}

/**
 * Why a line's relation may not act on its target, or null if it may. The
 * target is always the same furnisher's line, because relations are looked up
 * by the relating line's own furnisher_id.
 */
export function relationProblem(relating: Line, target: Line): string | null {
  if (relating.eventId === target.eventId) return "it points at itself";
  if (!relating.proofOk) return "its own proof has not passed";
  if (relating.dataClass !== target.dataClass) {
    return `a ${relating.dataClass} line cannot act on a ${target.dataClass} line`;
  }
  // A line erased with its source (server/lineExpiry.ts) names no subject.
  if (!relating.subjectRef || !target.subjectRef) {
    return "its source has expired";
  }
  if (subjectKey(relating.subjectRef) !== subjectKey(target.subjectRef)) {
    return "it names a different subject";
  }
  return null;
}

// Each reviewer's latest decision about this exact event and data class, by
// the time they signed it (ties go to the later record).
export function currentDecisions(line: Line, reviews: Review[]): Review[] {
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    if (review.signedEventHash !== line.signedEventHash) continue;
    if (review.dataClass !== line.dataClass) continue;
    const seen = latest.get(review.reviewerId);
    const later =
      !seen ||
      review.decidedAt.getTime() > seen.decidedAt.getTime() ||
      (review.decidedAt.getTime() === seen.decidedAt.getTime() &&
        review.id > seen.id);
    if (later) latest.set(review.reviewerId, review);
  }
  return [...latest.values()];
}

/**
 * Whether reviewers have released the line (Phase 0 item 6), and if not, why.
 * reviews must already be limited to listed reviewers. A line needs its proof
 * passed and two approvals from different reviewers, one for test data. An
 * approval counts only with evidence verified, unless it waives evidence a
 * person must judge; a failed check cannot be waived. An approval counts only
 * while the line's evidence result is the one the reviewer signed for, so a
 * later change (a reused charge, say) needs a new review. Any current
 * rejection holds the line, whatever evidence it was signed against.
 */
export function releaseFor(
  line: Line,
  reviews: Review[]
): { released: Release | null; holdingBack: string | null } {
  const hold = (holdingBack: string) => ({ released: null, holdingBack });
  if (!line.proofOk) return hold("its proof has not passed");
  // A MariaDB server older than 10.5.2 returns the JSON column as text.
  let result: unknown = line.evidenceResult;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      result = null;
    }
  }
  // A line backed by a charge counts only while it holds that charge's claim,
  // which is unique, so no two released lines can rest on one charge (review
  // M-02).
  const charge = isRecord(result) ? result.charge : undefined;
  if (
    isRecord(charge) &&
    line.evidenceKey !== chargeKey(charge as LevyCharge)
  ) {
    return hold(
      "it does not hold the claim on its charge: the furnisher's merchant account is not vetted, or another line holds it"
    );
  }
  const evidence = line.evidenceStatus;
  if (evidence === "failed") {
    return hold("its evidence check failed, which cannot be waived");
  }
  if (evidence !== "verified" && evidence !== "needs_review") {
    return hold(
      `its evidence is ${evidence ?? "not checked"}; run the intake again`
    );
  }
  const decisions = currentDecisions(line, reviews);
  const held = decisions.filter(d => d.suspended).map(d => d.reviewerId);
  if (held.length > 0) {
    return hold(
      `${held.join(", ")} decided on it and ${held.length > 1 ? "are" : "is"} suspended; held until the other reviewers re-enable, rotate or remove them`
    );
  }
  const rejected = decisions.filter(d => d.decision === "reject");
  if (rejected.length > 0) {
    return hold(`rejected by ${rejected.map(d => d.reviewerId).join(", ")}`);
  }
  // A settled payment counts on a plain approval only when its funding screen
  // is clear; a flag, an inconclusive screen or none needs a person to waive it
  // with a reason (review M-04, decided 2026-10-31). An evidence result that
  // cannot be read at all is held the same way.
  const screened = isRecord(result) ? result.funding_screen : undefined;
  const screenHolds =
    !isRecord(result) ||
    (isRecord(charge) &&
      charge.kind === "charged" &&
      !(isRecord(screened) && screened.result === "clear"));
  const plain = evidence === "verified" && !screenHolds;
  const digest = evidenceDigest(line.evidenceResult);
  const approvals = decisions.filter(
    d =>
      d.evidenceDigest === digest &&
      (plain || d.decision === "approve_with_waiver")
  ).length;
  if (approvals >= 2) return { released: "two_person", holdingBack: null };
  if (approvals === 1 && line.dataClass === "test") {
    return { released: "solo_test", holdingBack: null };
  }
  const missing = 2 - approvals;
  const plural = missing > 1;
  const what = plain
    ? `approval${plural ? "s" : ""}`
    : `approval${plural ? "s that waive" : " that waives"} the ${evidence === "verified" ? "funding screen's result" : "evidence"}`;
  const test = line.dataClass === "test" ? " (test data: one is enough)" : "";
  return hold(`needs ${missing} more ${what} from different reviewers${test}`);
}

/**
 * Whether a new line may take over the settlement log its target claims: it
 * corrects or supersedes that line, is the same furnisher's, and its relation
 * acts (relationProblem). Any other line naming the same charge is a second
 * line on it, and its evidence fails (review M-02).
 */
export function takesOverClaim(relating: Line, holder: Line): boolean {
  return (
    (relating.relationType === "corrects" ||
      relating.relationType === "supersedes") &&
    relating.relationTargetEventId === holder.eventId &&
    relating.furnisherId === holder.furnisherId &&
    relationProblem(relating, holder) === null
  );
}

/**
 * The line's states, given the later lines whose relation targets it, the
 * listed reviewers' decisions and the state of the subject's dispute on it, if
 * any (server/dispute.ts). A dispute the furnisher has since withdrawn stops
 * acting (owner decision, 2026-10-31). A withdrawn correction or withdrawal
 * stays in force: to bring a line back, the furnisher sends a new one. A line
 * whose subject dispute lapsed is removed, and never released again.
 */
export function lineStates(
  line: Line,
  relating: Line[],
  reviews: Review[] = [],
  subjectDispute: DisputeState | null = null
): LineStates {
  const acting = relating.filter(
    r =>
      relationProblem(r, line) === null &&
      !(r.relationType === "disputes" && r.displayState === "withdrawn")
  );
  const has = (...types: RelationType[]) =>
    acting.some(r => r.relationType !== null && types.includes(r.relationType));
  const removed = subjectDispute === "lapsed";
  return {
    sealed: true,
    source_signed: line.proofOk,
    evidence_verified: line.evidenceStatus === "verified",
    disputed: has("disputes"),
    withdrawn: has("withdraws"),
    superseded: has("supersedes", "corrects"),
    released: removed ? null : releaseFor(line, reviews).released,
    ...(subjectDispute ? { subject_dispute: subjectDispute, removed } : {}),
  };
}

/**
 * How the line may be shown (Phase 0 decision 4). A removal after a lapsed
 * subject dispute outranks everything. Then a withdrawal outranks a
 * replacement, which outranks a dispute, the furnisher's or the subject's while
 * open or confirmed, which outranks a release: a dispute shows at once, even on
 * a released line.
 */
export function displayStateFor(states: LineStates): DisplayState {
  if (states.removed) return "removed";
  if (states.withdrawn) return "withdrawn";
  if (states.superseded) return "superseded";
  if (
    states.disputed ||
    states.subject_dispute === "open" ||
    states.subject_dispute === "confirmed"
  ) {
    return "disputed";
  }
  if (states.released) return "released";
  return "unverified";
}
