// What is known about a stored line, kept apart instead of folded into one
// "verified" bit (the 2026-10-31 review, proof contract): CounterAudit sealed
// it, the furnisher's signature checked out through CounterAudit's proof, its
// evidence passed, and what later lines from the same furnisher did to it.
// See docs/line-states.md.
import canonicalize from "canonicalize";
import type {
  DISPLAY_STATES,
  OutcomeEvent,
  RELATION_TYPES,
} from "../drizzle/schema";

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
  | "displayState"
  | "relationType"
  | "relationTargetEventId"
>;

export type LineStates = {
  sealed: true;
  source_signed: boolean;
  evidence_verified: boolean;
  disputed: boolean;
  withdrawn: boolean;
  superseded: boolean;
};

// EVM addresses compare without case; everything else exactly. A MariaDB
// server older than 10.5.2 returns the JSON column as text, so parse it first.
function subjectKey(stored: Record<string, unknown> | string): string {
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
  const wallet = (subjectRef as Record<string, unknown>).wallet;
  const normalized =
    typeof wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(wallet)
      ? { ...subjectRef, wallet: wallet.toLowerCase() }
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
  if (subjectKey(relating.subjectRef) !== subjectKey(target.subjectRef)) {
    return "it names a different subject";
  }
  return null;
}

/**
 * The line's states, given the later lines whose relation targets it. A
 * dispute the furnisher has since withdrawn stops acting (owner decision,
 * 2026-10-31). A withdrawn correction or withdrawal stays in force: to bring a
 * line back, the furnisher sends a new one.
 */
export function lineStates(line: Line, relating: Line[]): LineStates {
  const acting = relating.filter(
    r =>
      relationProblem(r, line) === null &&
      !(r.relationType === "disputes" && r.displayState === "withdrawn")
  );
  const has = (...types: RelationType[]) =>
    acting.some(r => r.relationType !== null && types.includes(r.relationType));
  return {
    sealed: true,
    source_signed: line.proofOk,
    evidence_verified: line.evidenceStatus === "verified",
    disputed: has("disputes"),
    withdrawn: has("withdraws"),
    superseded: has("supersedes", "corrects"),
  };
}

/**
 * How the line may be shown (Phase 0 decision 4). A withdrawal outranks a
 * replacement, which outranks a dispute. Never "verified": that also needs
 * two-person review, which is not built.
 */
export function displayStateFor(states: LineStates): DisplayState {
  if (states.withdrawn) return "withdrawn";
  if (states.superseded) return "superseded";
  if (states.disputed) return "disputed";
  return "unverified";
}
