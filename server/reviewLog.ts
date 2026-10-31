// The independent review log (review finding M-03; docs/review-log-design.md, decided
// 2026-10-31). Reviewers seal their own signed records in a dedicated CounterAudit organization:
// their decisions on lines, and changes to who the reviewers are. The operator never handles
// them. This module holds the reviewer-key record format and the rules that turn the sealed
// chain, read in order, into a reviewer set and the decisions that count. Anyone holding a read
// key to the review organization can apply the same rules and reach the same answer.
import {
  createHash,
  createPrivateKey,
  sign,
  verify,
} from "node:crypto";
import {
  canonicalizeJson,
  decodeCanonicalBase64url,
  isRecord,
  parsePublicKey,
} from "./outcomeProof";
import {
  REVIEW_SCHEMA,
  checkReviewDecision,
  type ReviewDecision,
} from "./reviewDecision";

export const REVIEWER_KEY_SCHEMA = "agent-bureau/reviewer-key/v1";
export const REVIEW_CONNECTOR_ID = "agent-bureau-review-v1";
// Two reviewers make a key change; one suspends.
export const QUORUM = 2;
// The one genesis the Bureau counts: genesisHash of the first reviewers, set by pull request once
// they agree on it (docs/two-person-review.md, Setup). Pinned here, a genesis sealed first by
// whoever administers the review organization counts for nothing. Until it is set, no genesis
// counts and nothing is released.
export const REVIEW_GENESIS: string | null = "8cb804864151e37ef952ddfef76ff788dffe6508bab7d50cfb17a5f51b5456df";
// The testnet genesis (2026-10-31): three reviewers the operator holds, named as such in the
// testnet review organization, so the review flow runs end to end on testnet. While it is the
// pinned genesis, a decision on live data counts for nothing, so no live line is released: live
// data waits for a genesis of independent reviewers, in a review organization of their own, whose
// hash replaces the pin. The testnet reviewers' decisions then stop counting.
export const TESTNET_GENESIS = "8cb804864151e37ef952ddfef76ff788dffe6508bab7d50cfb17a5f51b5456df";
const SIGNING_CONTEXT = `${REVIEWER_KEY_SCHEMA}\n`;
const SIGNATURE_PREFIX = "ed25519:";
export const REVIEWER_ID = /^rev_[a-z0-9]{3,32}$/;
const DECIDED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
// A record dated further than this after it was sealed is not taken.
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;
// Nor a reviewer-key record sealed longer than this after it was signed.
const MAX_SEAL_DELAY_MS = 24 * 60 * 60 * 1000;
// Only the canonical spelling, so no two spellings of one key pass as two reviewers' keys.
const PUBLIC_KEY = /^ed25519:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export type ReviewerEntry = { reviewer_id: string; name: string; public_key: string };
export type KeyChange =
  | { type: "genesis"; reviewers: ReviewerEntry[] }
  | { type: "add"; reviewer_id: string; name: string; public_key: string }
  | { type: "rotate"; reviewer_id: string; public_key: string }
  | { type: "suspend" | "reenable" | "remove"; reviewer_id: string };
export type ReviewerKeyRecord = {
  schema: typeof REVIEWER_KEY_SCHEMA;
  signer_id: string;
  change: KeyChange;
  reason?: string;
  decided_at: string;
  signature: string;
};

const exactKeys = (value: Record<string, unknown>, allowed: string[], required: string[]) =>
  Object.keys(value).every(k => allowed.includes(k)) && required.every(k => k in value);

function usablePublicKey(text: unknown): text is string {
  if (typeof text !== "string" || !PUBLIC_KEY.test(text)) return false;
  try {
    parsePublicKey(text);
    return true;
  } catch {
    return false;
  }
}

function changeProblem(change: unknown): string | null {
  if (!isRecord(change)) return "change is not an object";
  const id = change.reviewer_id;
  const idOk = typeof id === "string" && REVIEWER_ID.test(id);
  const nameOk = (v: unknown) => typeof v === "string" && v.length >= 1 && v.length <= 120;
  switch (change.type) {
    case "genesis": {
      if (!exactKeys(change, ["type", "reviewers"], ["type", "reviewers"])) return "a genesis has type and reviewers only";
      const list = change.reviewers;
      if (!Array.isArray(list) || list.length < 3 || list.length > 20) return "a genesis names 3 to 20 reviewers";
      for (const r of list) {
        if (
          !isRecord(r) ||
          !exactKeys(r, ["reviewer_id", "name", "public_key"], ["reviewer_id", "name", "public_key"]) ||
          typeof r.reviewer_id !== "string" || !REVIEWER_ID.test(r.reviewer_id) ||
          !nameOk(r.name) || !usablePublicKey(r.public_key)
        ) {
          return "each genesis reviewer needs a rev_ id, a name and an ed25519 public key";
        }
      }
      const ids = new Set(list.map(r => (r as ReviewerEntry).reviewer_id));
      const keys = new Set(list.map(r => (r as ReviewerEntry).public_key));
      if (ids.size !== list.length || keys.size !== list.length) return "a genesis names each reviewer and each key once";
      return null;
    }
    case "add":
      return exactKeys(change, ["type", "reviewer_id", "name", "public_key"], ["type", "reviewer_id", "name", "public_key"]) &&
        idOk && nameOk(change.name) && usablePublicKey(change.public_key)
        ? null
        : "an add has a rev_ id, a name and an ed25519 public key";
    case "rotate":
      return exactKeys(change, ["type", "reviewer_id", "public_key"], ["type", "reviewer_id", "public_key"]) &&
        idOk && usablePublicKey(change.public_key)
        ? null
        : "a rotation has a rev_ id and an ed25519 public key";
    case "suspend":
    case "reenable":
    case "remove":
      return exactKeys(change, ["type", "reviewer_id"], ["type", "reviewer_id"]) && idOk
        ? null
        : `a ${change.type} has a rev_ id only`;
    default:
      return "change.type must be genesis, add, rotate, suspend, reenable or remove";
  }
}

/** Checks a reviewer-key record's form; its signature is checked by whoever knows the signer's key. */
export function checkKeyRecordForm(
  value: unknown
): { ok: true; record: ReviewerKeyRecord } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!isRecord(value)) return fail("not a JSON object");
  if (!exactKeys(value, ["schema", "signer_id", "change", "reason", "decided_at", "signature"], ["schema", "signer_id", "change", "decided_at", "signature"])) {
    return fail("fields must be schema, signer_id, change, decided_at, signature and an optional reason");
  }
  if (value.schema !== REVIEWER_KEY_SCHEMA) return fail(`schema is not ${REVIEWER_KEY_SCHEMA}`);
  if (typeof value.signer_id !== "string" || !REVIEWER_ID.test(value.signer_id)) {
    return fail("signer_id must look like rev_ and 3 to 32 lowercase letters or digits");
  }
  const problem = changeProblem(value.change);
  if (problem) return fail(problem);
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 500)) {
    return fail("reason must be text of at most 500 characters");
  }
  if (typeof value.decided_at !== "string" || !DECIDED_AT.test(value.decided_at) || Number.isNaN(Date.parse(value.decided_at))) {
    return fail("decided_at must be an ISO time in UTC with milliseconds");
  }
  if (
    typeof value.signature !== "string" ||
    !value.signature.startsWith(SIGNATURE_PREFIX) ||
    !decodeCanonicalBase64url(value.signature.slice(SIGNATURE_PREFIX.length), 64)
  ) {
    return fail("the signature is not 64 bytes of canonical base64url");
  }
  return { ok: true, record: value as ReviewerKeyRecord };
}

function signingPayload(unsigned: Record<string, unknown>): Buffer {
  return Buffer.from(SIGNING_CONTEXT + canonicalizeJson(unsigned), "utf8");
}

/** Signs a reviewer-key record with the signer's private key (PKCS#8 PEM). */
export function signKeyRecord(
  unsigned: Omit<ReviewerKeyRecord, "signature">,
  privateKeyPem: string
): ReviewerKeyRecord {
  const signature = sign(null, signingPayload(unsigned), createPrivateKey(privateKeyPem));
  return { ...unsigned, signature: `${SIGNATURE_PREFIX}${signature.toString("base64url")}` };
}

/** Whether a well-formed record's signature checks with a public key. */
export function keyRecordVerifies(record: ReviewerKeyRecord, publicKeyText: string): boolean {
  const bytes = decodeCanonicalBase64url(record.signature.slice(SIGNATURE_PREFIX.length), 64);
  if (!bytes) return false;
  try {
    const { signature: _signature, ...unsigned } = record;
    return verify(null, signingPayload(unsigned), parsePublicKey(publicKeyText), bytes);
  } catch {
    return false;
  }
}

const hashOf = (value: unknown) => createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");

/** SHA-256 (hex) of a genesis change naming these reviewers, the value REVIEW_GENESIS pins. */
export function genesisHash(reviewers: ReviewerEntry[]): string {
  return hashOf({ type: "genesis", reviewers });
}

export type ReviewerStatus = "active" | "suspended" | "removed";
export type ReviewerState = { name: string; publicKey: string; status: ReviewerStatus };

/** One sealed packet of the review organization, as `pnpm review sync` stored it. */
export type LogRecord = {
  sequence: number;
  packetId: string;
  sealedAt: Date;
  // The signed record, or null for a packet of another connector or one whose content is gone.
  record: unknown;
};

export type CountedDecision = {
  decision: ReviewDecision;
  sequence: number;
  packetId: string;
  // By a suspended reviewer: it does not count, and it holds its line until the quorum decides.
  suspended: boolean;
};

export type ReviewLog = {
  // null until a genesis has taken effect.
  reviewers: Map<string, ReviewerState> | null;
  decisions: CountedDecision[];
  // What each reviewer-key record did, in order, for the operator and the reviewers to read.
  events: { sequence: number; text: string }[];
  // The last sequence read, or null for an empty log.
  readTo: number | null;
  // Whether the genesis in effect is the operator-held testnet one: only test-data decisions count.
  testnet: boolean;
};

function describe(change: KeyChange): string {
  return change.type === "genesis"
    ? `genesis of ${change.reviewers.map(r => r.reviewer_id).join(", ")}`
    : `${change.type} ${change.reviewer_id}`;
}

/** Why a change cannot apply to the reviewers as they stand, or null. */
function stateProblem(change: Exclude<KeyChange, { type: "genesis" }>, reviewers: Map<string, ReviewerState>): string | null {
  const target = reviewers.get(change.reviewer_id);
  const keyTaken = (key: string) => [...reviewers.entries()].some(([id, r]) => id !== change.reviewer_id && r.publicKey === key);
  switch (change.type) {
    case "add":
      if (target) return `${change.reviewer_id} is already a reviewer`;
      return keyTaken(change.public_key) ? "the key is another reviewer's" : null;
    case "rotate":
      if (!target || target.status === "removed") return `${change.reviewer_id} is not a reviewer`;
      if (target.publicKey === change.public_key) return "the key is already theirs";
      return keyTaken(change.public_key) ? "the key is another reviewer's" : null;
    case "suspend":
      return target?.status === "active" ? null : `${change.reviewer_id} is not an active reviewer`;
    case "reenable":
      return target?.status === "suspended" ? null : `${change.reviewer_id} is not suspended`;
    case "remove":
      return target && target.status !== "removed" ? null : `${change.reviewer_id} is not a reviewer`;
  }
}

/**
 * Applies the review log's rules (docs/review-log-design.md, Rules) to its records in sequence
 * order: the pinned genesis, once every reviewer it names has signed it, sets the reviewers; one
 * reviewer suspends; two different reviewers add, rotate, re-enable or remove; and a decision
 * counts when it checks with its reviewer's current key. A decision by a suspended reviewer is
 * kept, marked, so its line is held. Suspension holds a reviewer's decisions, not their vote, so
 * no one key can suspend the others out of the quorum.
 */
export function replayReviewLog(
  records: LogRecord[],
  pinned: string | null = REVIEW_GENESIS,
  testnetGenesis: string | null = TESTNET_GENESIS
): ReviewLog {
  const testnet = pinned !== null && pinned === testnetGenesis;
  const ordered = [...records].sort((a, b) => a.sequence - b.sequence);
  let reviewers: Map<string, ReviewerState> | null = null;
  const genesisVotes = new Map<string, Set<string>>();
  // Votes for changes not yet in effect, by change. Any change taking effect clears them all, so
  // a vote counts only toward the reviewers as they stood when it was cast.
  const votes = new Map<string, Set<string>>();
  // Key records already taken, by signature: one sealed again counts for nothing.
  const seen = new Set<string>();
  const decisions: LogRecord[] = [];
  const events: { sequence: number; text: string }[] = [];

  for (const entry of ordered) {
    const value = entry.record;
    if (!isRecord(value)) continue;
    if (value.schema === REVIEW_SCHEMA) {
      decisions.push(entry);
      continue;
    }
    if (value.schema !== REVIEWER_KEY_SCHEMA) continue;
    const note = (text: string) => events.push({ sequence: entry.sequence, text });
    const form = checkKeyRecordForm(value);
    if (!form.ok) {
      note(`ignored, ${form.reason}`);
      continue;
    }
    const record = form.record;
    const change = record.change;
    const signedAt = Date.parse(record.decided_at);
    if (signedAt > entry.sealedAt.getTime() + MAX_CLOCK_AHEAD_MS) {
      note(`ignored, dated after it was sealed`);
      continue;
    }
    if (signedAt < entry.sealedAt.getTime() - MAX_SEAL_DELAY_MS) {
      note(`ignored, sealed more than a day after it was signed`);
      continue;
    }
    if (change.type === "genesis") {
      if (reviewers) {
        note(`ignored, a genesis after the first counts for nothing`);
        continue;
      }
      if (pinned === null || genesisHash(change.reviewers) !== pinned) {
        note(`ignored, not the genesis pinned in server/reviewLog.ts`);
        continue;
      }
      const named = change.reviewers.find(r => r.reviewer_id === record.signer_id);
      if (!named || !keyRecordVerifies(record, named.public_key)) {
        note(`ignored, not signed by a reviewer the genesis names with the key it names`);
        continue;
      }
      const h = hashOf(change);
      const signers = genesisVotes.get(h) ?? new Set<string>();
      signers.add(record.signer_id);
      genesisVotes.set(h, signers);
      if (change.reviewers.every(r => signers.has(r.reviewer_id))) {
        reviewers = new Map(change.reviewers.map(r => [r.reviewer_id, { name: r.name, publicKey: r.public_key, status: "active" as const }]));
        note(`${describe(change)} took effect, signed by all of them`);
      } else {
        note(`${record.signer_id} signed the ${describe(change)}`);
      }
      continue;
    }
    if (!reviewers) {
      note(`ignored, no genesis has taken effect`);
      continue;
    }
    const current = reviewers;
    const signer = current.get(record.signer_id);
    if (!signer || signer.status === "removed" || !keyRecordVerifies(record, signer.publicKey)) {
      note(`ignored, not signed by a reviewer with their current key`);
      continue;
    }
    if (seen.has(record.signature)) {
      note(`ignored, sealed before`);
      continue;
    }
    seen.add(record.signature);
    const problem = stateProblem(change, current);
    if (problem) {
      note(`ignored, ${problem}`);
      continue;
    }
    if (change.type === "suspend") {
      current.get(change.reviewer_id)!.status = "suspended";
      votes.clear();
      note(`${change.reviewer_id} suspended by ${record.signer_id}`);
      continue;
    }
    const h = hashOf(change);
    const signers = votes.get(h) ?? new Set<string>();
    signers.add(record.signer_id);
    votes.set(h, signers);
    if (signers.size < QUORUM) {
      note(`${record.signer_id} voted to ${describe(change)} (${signers.size} of ${QUORUM})`);
      continue;
    }
    votes.clear();
    if (change.type === "add") {
      current.set(change.reviewer_id, { name: change.name, publicKey: change.public_key, status: "active" });
    } else {
      const target = current.get(change.reviewer_id)!;
      if (change.type === "rotate") {
        // A new key settles a suspension: decisions signed with the old one stop counting.
        target.publicKey = change.public_key;
        target.status = "active";
      } else {
        target.status = change.type === "reenable" ? "active" : "removed";
      }
    }
    note(`${describe(change)} took effect, voted by ${[...signers].join(" and ")}`);
  }

  const counted: CountedDecision[] = [];
  if (reviewers) {
    for (const entry of decisions) {
      const id = (entry.record as Record<string, unknown>).reviewer_id;
      const state = typeof id === "string" ? reviewers.get(id) : undefined;
      if (!state || state.status === "removed") continue;
      // Checked as sealed: not dated more than a few minutes after CounterAudit sealed it.
      const checked = checkReviewDecision(entry.record, { [id as string]: { name: state.name, publicKey: state.publicKey } }, entry.sealedAt);
      if (!checked.ok) continue;
      if (testnet && checked.decision.data_class === "live") continue;
      counted.push({
        decision: checked.decision,
        sequence: entry.sequence,
        packetId: entry.packetId,
        suspended: state.status === "suspended",
      });
    }
  }
  return {
    reviewers,
    decisions: counted,
    events,
    readTo: ordered.length ? ordered[ordered.length - 1].sequence : null,
    testnet,
  };
}
