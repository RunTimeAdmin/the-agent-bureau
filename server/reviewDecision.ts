// Signed review decisions (Phase 0 item 6; docs/two-person-review.md). Each
// reviewer makes an Ed25519 key on their own machine and signs decisions with
// it there. Who the reviewers are, and which key is each one's, comes from the
// independent review log (server/reviewLog.ts), not from this code.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { REVIEW_DECISIONS } from "../drizzle/schema";
import {
  canonicalizeJson,
  decodeCanonicalBase64url,
  isRecord,
  parsePublicKey,
} from "./outcomeProof";

export const REVIEW_SCHEMA = "agent-bureau/review-decision/v1";
// Domain separation: nothing else a reviewer's key signs can verify as a
// decision.
const SIGNING_CONTEXT = `${REVIEW_SCHEMA}\n`;
const SIGNATURE_PREFIX = "ed25519:";

export type ReviewDecisionKind = (typeof REVIEW_DECISIONS)[number];
export type Reviewer = { name: string; publicKey: string };


export type ReviewDecision = {
  schema: typeof REVIEW_SCHEMA;
  reviewer_id: string;
  furnisher_id: string;
  event_id: string;
  signed_event_hash: string;
  // The line's data class and the digest of its evidence result as the
  // reviewer saw them (pnpm review queue prints both). An approval counts only
  // while the line's evidence still has this digest.
  data_class: "test" | "live";
  evidence_digest: string;
  decision: ReviewDecisionKind;
  reason?: string;
  decided_at: string;
  signature: string;
};

const FIELDS = new Set([
  "schema",
  "reviewer_id",
  "furnisher_id",
  "event_id",
  "signed_event_hash",
  "data_class",
  "evidence_digest",
  "decision",
  "reason",
  "decided_at",
  "signature",
]);

// A decision signed further ahead than this is refused: the latest decision
// counts, so a far-future one would win for good.
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;

export type CheckedDecision =
  { ok: true; decision: ReviewDecision } | { ok: false; reason: string };

function signingPayload(unsigned: Record<string, unknown>): Buffer {
  return Buffer.from(SIGNING_CONTEXT + canonicalizeJson(unsigned), "utf8");
}

/** SHA-256 (hex) of a line's stored evidence result, canonical JSON. */
export function evidenceDigest(evidenceResult: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJson(evidenceResult ?? null), "utf8")
    .digest("hex");
}

/**
 * Reads one signed decision and checks its form, reviewer and signature. now
 * is null when re-checking a recorded decision, whose time was checked when it
 * was recorded.
 */
export function checkReviewDecision(
  value: unknown,
  reviewers: Record<string, Reviewer>,
  now: Date | null = new Date()
): CheckedDecision {
  const fail = (reason: string): CheckedDecision => ({ ok: false, reason });
  if (!isRecord(value)) return fail("not a JSON object");
  const extra = Object.keys(value).filter(key => !FIELDS.has(key));
  if (extra.length > 0) return fail(`unexpected fields: ${extra.join(", ")}`);
  const {
    schema,
    reviewer_id,
    furnisher_id,
    event_id,
    signed_event_hash,
    data_class,
    evidence_digest,
    decision,
    reason,
    decided_at,
    signature,
  } = value;
  if (schema !== REVIEW_SCHEMA) return fail(`schema is not ${REVIEW_SCHEMA}`);
  if (
    typeof reviewer_id !== "string" ||
    !/^rev_[a-z0-9]{3,32}$/.test(reviewer_id)
  ) {
    return fail(
      "reviewer_id must look like rev_ and 3 to 32 lowercase letters or digits"
    );
  }
  const reviewer = Object.hasOwn(reviewers, reviewer_id)
    ? reviewers[reviewer_id]
    : undefined;
  if (!reviewer) return fail(`${reviewer_id} is not a listed reviewer`);
  if (
    typeof furnisher_id !== "string" ||
    !/^fur_[a-z0-9]{6,32}$/.test(furnisher_id) ||
    typeof event_id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(event_id)
  ) {
    return fail("furnisher_id or event_id is not a v1 id");
  }
  if (
    typeof signed_event_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(signed_event_hash)
  ) {
    return fail("signed_event_hash must be 64 lowercase hex characters");
  }
  if (data_class !== "test" && data_class !== "live") {
    return fail("data_class must be test or live");
  }
  if (
    typeof evidence_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(evidence_digest)
  ) {
    return fail("evidence_digest must be 64 lowercase hex characters");
  }
  if (!REVIEW_DECISIONS.includes(decision as ReviewDecisionKind)) {
    return fail(`decision must be one of ${REVIEW_DECISIONS.join(", ")}`);
  }
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.length > 500)
  ) {
    return fail("reason must be text of at most 500 characters");
  }
  if (
    decision !== "approve" &&
    (typeof reason !== "string" || reason.trim() === "")
  ) {
    return fail(`${decision} needs a reason`);
  }
  if (
    typeof decided_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(decided_at) ||
    Number.isNaN(Date.parse(decided_at))
  ) {
    return fail("decided_at must be an ISO time in UTC with milliseconds");
  }
  if (now && Date.parse(decided_at) > now.getTime() + MAX_CLOCK_AHEAD_MS) {
    return fail("decided_at is in the future");
  }
  if (
    typeof signature !== "string" ||
    !signature.startsWith(SIGNATURE_PREFIX)
  ) {
    return fail("the decision is not signed");
  }
  const bytes = decodeCanonicalBase64url(
    signature.slice(SIGNATURE_PREFIX.length),
    64
  );
  if (!bytes)
    return fail("the signature is not 64 bytes of canonical base64url");
  let publicKey;
  try {
    publicKey = parsePublicKey(reviewer.publicKey);
  } catch (error) {
    return fail(
      `${reviewer_id}'s listed key is unusable: ${(error as Error).message}`
    );
  }
  const { signature: _signature, ...unsigned } = value;
  if (!verify(null, signingPayload(unsigned), publicKey, bytes)) {
    return fail(`the signature does not verify with ${reviewer_id}'s key`);
  }
  return { ok: true, decision: value as ReviewDecision };
}

/** Signs a decision with a reviewer's private key (PKCS#8 PEM). */
export function signReviewDecision(
  unsigned: Omit<ReviewDecision, "signature">,
  privateKeyPem: string
): ReviewDecision {
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, signingPayload(unsigned), key);
  return {
    ...unsigned,
    signature: `${SIGNATURE_PREFIX}${signature.toString("base64url")}`,
  };
}

/** The public key, as a genesis or key record names it, for a private key (PKCS#8 PEM). */
export function reviewerPublicKey(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({
    format: "jwk",
  });
  return `${SIGNATURE_PREFIX}${jwk.x}`;
}

/** A new reviewer key pair. */
export function newReviewerKey(): { privateKeyPem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  return { privateKeyPem, publicKey: reviewerPublicKey(privateKeyPem) };
}
