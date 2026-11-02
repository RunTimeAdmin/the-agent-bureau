// Furnisher admission (the owner's decision, 2026-11-02): only vetted, arm's-length furnishers,
// admitted under two-person review and then on probation. Two different reviewers each sign an
// admission for the furnisher's CounterAudit organization and the keys being admitted, and seal
// it in the review log (docs/review-log-design.md). Until then no live line of that furnisher is
// released; during probation a live line cannot be released on a waiver. One reviewer's
// revocation ends an admission at once. Who the reviewers are, and which key is each one's,
// comes from the review log, as for decisions.
import { createHash, createPrivateKey, sign, verify } from "node:crypto";
import { FURNISHERS, type Furnisher } from "./furnishers";
import {
  canonicalizeJson,
  decodeCanonicalBase64url,
  isRecord,
  parsePublicKey,
} from "./outcomeProof";
import type { LogRecord, ReviewerState, ReviewerStatus } from "./reviewLog";

export const ADMISSION_SCHEMA = "agent-bureau/furnisher-admission/v1";
// Domain separation: nothing else a reviewer's key signs can verify as an admission.
const SIGNING_CONTEXT = `${ADMISSION_SCHEMA}\n`;
const SIGNATURE_PREFIX = "ed25519:";
export const MIN_PROBATION_DAYS = 90;
export const MAX_PROBATION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
// The bounds the review log puts on reviewer-key records: not dated more than a few minutes
// after CounterAudit sealed it, and not sealed more than a day after it was signed.
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;
const MAX_SEAL_DELAY_MS = DAY_MS;

const REVIEWER_ID = /^rev_[a-z0-9]{3,32}$/;
const FURNISHER_ID = /^fur_[a-z0-9]{6,32}$/;
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// The one canonical base64url spelling of a 32-byte key.
const PUBLIC_KEY = /^ed25519:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const DECIDED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_KEYS = 20;

export type AdmittedKey = { key_id: string; public_key: string };

export type FurnisherAdmission = {
  schema: typeof ADMISSION_SCHEMA;
  reviewer_id: string;
  furnisher_id: string;
  decided_at: string;
  signature: string;
} & (
  | {
      decision: "admit";
      counteraudit_org_id: string;
      // The keys being admitted, sorted by key_id.
      keys: AdmittedKey[];
      // The reviewer's word that the furnisher was vetted and deals at arm's length.
      arms_length: true;
      // How long the probation lasts, in days.
      probation_days: number;
    }
  | {
      // Ends the furnisher's admission whatever organization and keys it named.
      decision: "revoke";
      reason: string;
    }
);

// The record before it is signed, for either decision.
export type UnsignedAdmission = FurnisherAdmission extends infer T
  ? T extends unknown
    ? Omit<T, "signature">
    : never
  : never;

const COMMON_FIELDS = ["schema", "reviewer_id", "furnisher_id", "decision", "decided_at", "signature"];
const FIELDS = {
  admit: new Set([...COMMON_FIELDS, "counteraudit_org_id", "keys", "arms_length", "probation_days"]),
  revoke: new Set([...COMMON_FIELDS, "reason"]),
};

function usablePublicKey(text: unknown): text is string {
  if (typeof text !== "string" || !PUBLIC_KEY.test(text)) return false;
  try {
    parsePublicKey(text);
    return true;
  } catch {
    return false;
  }
}

/** Why the keys are not a list an admission can name, or null. */
function keysProblem(keys: unknown): string | null {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) {
    return `keys must list 1 to ${MAX_KEYS} keys`;
  }
  const publicKeys = new Set<string>();
  let previous = "";
  for (const key of keys) {
    if (!isRecord(key) || Object.keys(key).length !== 2 || typeof key.key_id !== "string") {
      return "each key is {key_id, public_key} and nothing else";
    }
    if (!KEY_ID.test(key.key_id)) return `${key.key_id} is not a key id`;
    if (!usablePublicKey(key.public_key)) {
      return `${key.key_id}: public_key is not a usable Ed25519 key in its canonical spelling`;
    }
    // Sorted and each once, so the same keys always make the same admission.
    if (key.key_id <= previous) return "keys must be sorted by key_id, each once";
    if (publicKeys.has(key.public_key)) return "a public key is listed twice";
    previous = key.key_id;
    publicKeys.add(key.public_key);
  }
  return null;
}

/** Reads one admission record and checks its form only: its signer and signature are the review log's. */
export function checkAdmissionForm(
  value: unknown
): { ok: true; record: FurnisherAdmission } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!isRecord(value)) return fail("not a JSON object");
  const v = value;
  if (v.schema !== ADMISSION_SCHEMA) return fail(`schema is not ${ADMISSION_SCHEMA}`);
  if (v.decision !== "admit" && v.decision !== "revoke") return fail("decision must be admit or revoke");
  const extra = Object.keys(v).filter(key => !FIELDS[v.decision as "admit" | "revoke"].has(key));
  if (extra.length > 0) return fail(`unexpected fields for ${v.decision}: ${extra.join(", ")}`);
  if (typeof v.reviewer_id !== "string" || !REVIEWER_ID.test(v.reviewer_id)) {
    return fail("reviewer_id must look like rev_ and 3 to 32 lowercase letters or digits");
  }
  if (typeof v.furnisher_id !== "string" || !FURNISHER_ID.test(v.furnisher_id)) {
    return fail("furnisher_id must look like fur_ and 6 to 32 lowercase letters or digits");
  }
  if (v.decision === "admit") {
    if (typeof v.counteraudit_org_id !== "string" || !ORG_ID.test(v.counteraudit_org_id)) {
      return fail("counteraudit_org_id must be a lowercase CounterAudit organization id");
    }
    const keys = keysProblem(v.keys);
    if (keys) return fail(keys);
    if (v.arms_length !== true) {
      return fail("an admission needs arms_length: true, the reviewer's word that the furnisher was vetted and deals at arm's length");
    }
    if (
      typeof v.probation_days !== "number" ||
      !Number.isInteger(v.probation_days) ||
      v.probation_days < MIN_PROBATION_DAYS ||
      v.probation_days > MAX_PROBATION_DAYS
    ) {
      return fail(`probation_days must be a whole number from ${MIN_PROBATION_DAYS} to ${MAX_PROBATION_DAYS}`);
    }
  } else if (typeof v.reason !== "string" || v.reason.trim() === "" || v.reason.length > 500) {
    return fail("a revocation needs a reason of at most 500 characters");
  }
  if (typeof v.decided_at !== "string" || !DECIDED_AT.test(v.decided_at) || Number.isNaN(Date.parse(v.decided_at))) {
    return fail("decided_at must be an ISO time in UTC with milliseconds");
  }
  if (typeof v.signature !== "string" || !v.signature.startsWith(SIGNATURE_PREFIX)) {
    return fail("the record is not signed");
  }
  if (!decodeCanonicalBase64url(v.signature.slice(SIGNATURE_PREFIX.length), 64)) {
    return fail("the signature is not 64 bytes of canonical base64url");
  }
  return { ok: true, record: value as FurnisherAdmission };
}

function signingPayload(unsigned: Record<string, unknown>): Buffer {
  return Buffer.from(SIGNING_CONTEXT + canonicalizeJson(unsigned), "utf8");
}

/** Signs an admission or revocation with a reviewer's private key (PKCS#8 PEM). */
export function signAdmission(unsigned: UnsignedAdmission, privateKeyPem: string): FurnisherAdmission {
  const signature = sign(null, signingPayload(unsigned), createPrivateKey(privateKeyPem));
  return { ...unsigned, signature: `${SIGNATURE_PREFIX}${signature.toString("base64url")}` } as FurnisherAdmission;
}

export function admissionVerifies(record: FurnisherAdmission, publicKeyText: string): boolean {
  const bytes = decodeCanonicalBase64url(record.signature.slice(SIGNATURE_PREFIX.length), 64);
  if (!bytes) return false;
  try {
    const { signature: _signature, ...unsigned } = record;
    return verify(null, signingPayload(unsigned), parsePublicKey(publicKeyText), bytes);
  } catch {
    return false;
  }
}

/** What two admissions must agree on to count together: the furnisher, its organization and the keys. */
function contentOf(record: { furnisher_id: string; counteraudit_org_id: string; keys: AdmittedKey[] }): string {
  return createHash("sha256")
    .update(
      canonicalizeJson({
        furnisher_id: record.furnisher_id,
        counteraudit_org_id: record.counteraudit_org_id,
        keys: record.keys,
      }),
      "utf8"
    )
    .digest("hex");
}

export type Admission = {
  orgId: string;
  keys: AdmittedKey[];
  // When CounterAudit sealed the admission that completed the pair.
  since: Date;
  probationUntil: Date;
  by: string[];
  sequence: number;
};

export type AdmissionState = {
  admitted: Admission | null;
  // The last revocation, while no admission has followed it.
  revoked: { at: Date; by: string; reason: string; sequence: number } | null;
  // Admissions still waiting for a second reviewer, by the keys they name.
  pending: { orgId: string; keys: AdmittedKey[]; by: string[] }[];
};

/** An admission record as sealed, with its reviewer as they stood when it was sealed, if one. */
export type AdmissionRecord = LogRecord & { signer: { publicKey: string; status: ReviewerStatus } | null };

/**
 * Applies the admission rules to the review log's admission records, in sequence order. A record
 * counts once per signature, when it was sealed within the review log's time bounds and checks
 * with the key its reviewer held when it was sealed, by a reviewer not removed then. A revocation
 * that counts stands for good: a later rotation, suspension or removal of the reviewer who sealed
 * it does not bring the admission back, and a suspended reviewer can revoke. An admission counts
 * only from a reviewer active when it was sealed and still active, with the same key, as the log
 * leaves them. Two different reviewers admitting the same organization and keys admit the
 * furnisher from the second one's sealing, on probation for the longer of the two periods; a
 * reviewer's newer admission replaces their pending one for other keys. One revocation ends the
 * admission and every pending vote. A later pair of admissions admits again, with a new probation.
 */
export function replayAdmissions(
  records: AdmissionRecord[],
  reviewers: Map<string, ReviewerState>,
  note: (sequence: number, text: string) => void
): Map<string, AdmissionState> {
  const states = new Map<string, AdmissionState>();
  // Votes not yet in effect, by furnisher, then by content; each reviewer's probation days.
  type Vote = { orgId: string; keys: AdmittedKey[]; days: Map<string, number> };
  const votes = new Map<string, Map<string, Vote>>();
  // The content each furnisher is admitted with now.
  const admittedContent = new Map<string, string>();
  const seen = new Set<string>();

  for (const entry of [...records].sort((a, b) => a.sequence - b.sequence)) {
    const say = (text: string) => note(entry.sequence, text);
    const form = checkAdmissionForm(entry.record);
    if (!form.ok) {
      say(`admission ignored, ${form.reason}`);
      continue;
    }
    const record = form.record;
    const signedAt = Date.parse(record.decided_at);
    if (signedAt > entry.sealedAt.getTime() + MAX_CLOCK_AHEAD_MS) {
      say("admission ignored, dated after it was sealed");
      continue;
    }
    if (signedAt < entry.sealedAt.getTime() - MAX_SEAL_DELAY_MS) {
      say("admission ignored, sealed more than a day after it was signed");
      continue;
    }
    const what = record.decision === "revoke" ? "revocation" : "admission";
    const then = entry.signer;
    if (!then || then.status === "removed" || !admissionVerifies(record, then.publicKey)) {
      say(`${what} ignored, not signed by a reviewer with the key they held when it was sealed`);
      continue;
    }
    if (seen.has(record.signature)) {
      say(`${what} ignored, sealed before`);
      continue;
    }
    seen.add(record.signature);
    const furnisherId = record.furnisher_id;
    const state = states.get(furnisherId) ?? { admitted: null, revoked: null, pending: [] };
    states.set(furnisherId, state);
    const pending = votes.get(furnisherId) ?? new Map<string, Vote>();
    votes.set(furnisherId, pending);

    if (record.decision === "revoke") {
      // Fail closed: a suspended reviewer can still stop a furnisher, and nothing done to the
      // reviewer afterwards undoes it.
      state.admitted = null;
      state.revoked = { at: entry.sealedAt, by: record.reviewer_id, reason: record.reason, sequence: entry.sequence };
      admittedContent.delete(furnisherId);
      pending.clear();
      say(`${furnisherId}'s admission revoked by ${record.reviewer_id}`);
      continue;
    }
    const reviewer = reviewers.get(record.reviewer_id);
    if (!reviewer || reviewer.status === "removed" || reviewer.publicKey !== then.publicKey) {
      say(`admission ignored, ${record.reviewer_id} has since been removed or given a new key`);
      continue;
    }
    if (then.status === "suspended" || reviewer.status === "suspended") {
      say(`admission of ${furnisherId} ignored, ${record.reviewer_id} ${then.status === "suspended" ? "was suspended when it was sealed" : "is suspended"}`);
      continue;
    }
    const content = contentOf(record);
    // A reviewer's newer admission replaces their pending one for other keys.
    for (const [other, vote] of pending) {
      if (other === content) continue;
      vote.days.delete(record.reviewer_id);
      if (vote.days.size === 0) pending.delete(other);
    }
    if (admittedContent.get(furnisherId) === content) {
      say(`${record.reviewer_id} admitted ${furnisherId}, already admitted with these keys`);
      continue;
    }
    const vote = pending.get(content) ?? { orgId: record.counteraudit_org_id, keys: record.keys, days: new Map<string, number>() };
    vote.days.set(record.reviewer_id, record.probation_days);
    pending.set(content, vote);
    if (vote.days.size < 2) {
      say(`${record.reviewer_id} voted to admit ${furnisherId} (1 of 2)`);
      continue;
    }
    // Any admission taking effect clears the pending votes, as a key change does.
    const days = Math.max(...vote.days.values());
    const by = [...vote.days.keys()];
    state.admitted = {
      orgId: vote.orgId,
      keys: vote.keys,
      since: entry.sealedAt,
      probationUntil: new Date(entry.sealedAt.getTime() + days * DAY_MS),
      by,
      sequence: entry.sequence,
    };
    state.revoked = null;
    admittedContent.set(furnisherId, content);
    pending.clear();
    say(`${furnisherId} admitted by ${by.join(" and ")}, on probation for ${days} days`);
  }

  for (const [furnisherId, pending] of votes) {
    states.get(furnisherId)!.pending = [...pending.values()].map(v => ({ orgId: v.orgId, keys: v.keys, by: [...v.days.keys()] }));
  }
  return states;
}

export type AdmissionGate =
  | { admitted: true; onProbation: boolean; probationUntil: Date | null }
  | { admitted: false; problem: string };

type LineSignerSource = {
  furnisherId: string;
  dataClass: "test" | "live";
  caCreatedAt?: Date | string;
  signedEvent?: unknown;
  receipt?: unknown;
};

/**
 * The organization and key a line was sealed and signed with, as CounterAudit's receipt (or the
 * proof a sealed intake kept) states them: the org_id, and the outcome claim's signer for the
 * key_id in the line's signed event. Null when they cannot be read.
 */
export function lineSigner(line: LineSignerSource): { orgId: string; keyId: string; publicKey: string } | null {
  const receipt = isRecord(line.receipt) ? line.receipt : null;
  const event = isRecord(line.signedEvent) ? line.signedEvent : null;
  const claim = receipt && isRecord(receipt.outcome_claim) ? receipt.outcome_claim : null;
  const signer = claim && isRecord(claim.signer) ? claim.signer : null;
  if (!receipt || !event || !signer) return null;
  const keyId = event.key_id;
  if (
    typeof receipt.org_id !== "string" ||
    typeof keyId !== "string" ||
    typeof signer.public_key !== "string" ||
    (signer.key_id !== undefined && signer.key_id !== keyId) ||
    (signer.furnisher_id !== undefined && signer.furnisher_id !== line.furnisherId)
  ) {
    return null;
  }
  return { orgId: receipt.org_id, keyId, publicKey: signer.public_key };
}

/**
 * Whether a line's furnisher is admitted for the organization and key the line came from, and
 * whether the line was sealed during its probation. Test data needs no admission. A key that
 * server/furnishers.ts lists for the furnisher must also be active there.
 */
export function admissionGate(
  line: LineSignerSource,
  admissions: Map<string, AdmissionState>,
  furnishers: Record<string, Furnisher> = FURNISHERS
): AdmissionGate {
  if (line.dataClass !== "live") return { admitted: true, onProbation: false, probationUntil: null };
  const state = admissions.get(line.furnisherId);
  const admitted = state?.admitted;
  if (!admitted) {
    return {
      admitted: false,
      problem: state?.revoked
        ? `its furnisher's admission was revoked by ${state.revoked.by} at sequence ${state.revoked.sequence}`
        : "its furnisher is not admitted by two reviewers (pnpm review admissions)",
    };
  }
  const signer = lineSigner(line);
  if (!signer) return { admitted: false, problem: "its receipt does not say which organization and key it came from" };
  if (signer.orgId !== admitted.orgId) {
    return { admitted: false, problem: `it was sealed in ${signer.orgId}, not the organization its furnisher was admitted for` };
  }
  if (!admitted.keys.some(k => k.key_id === signer.keyId && k.public_key === signer.publicKey)) {
    return { admitted: false, problem: `its key ${signer.keyId} is not one its furnisher was admitted with` };
  }
  const listed = Object.hasOwn(furnishers, line.furnisherId) ? furnishers[line.furnisherId] : undefined;
  if (listed) {
    const key = Object.hasOwn(listed.keys, signer.keyId) ? listed.keys[signer.keyId] : undefined;
    if (!key || key.status !== "active" || key.publicKey !== signer.publicKey) {
      return { admitted: false, problem: `its key ${signer.keyId} is not active in server/furnishers.ts` };
    }
  }
  // A line with no sealing time is taken as sealed during probation.
  const sealedAt = line.caCreatedAt ? new Date(line.caCreatedAt).getTime() : Number.NaN;
  const onProbation = !(sealedAt >= admitted.probationUntil.getTime());
  return { admitted: true, onProbation, probationUntil: admitted.probationUntil };
}
