// Reviewer approvals for the review organization's own CounterAudit keys (review finding M-03,
// build step 2; docs/review-log-design.md). In the review organization CounterAudit creates or
// revokes an API key, or changes which organization is the review organization, only with one of
// these: a reviewer's signature over the exact approval request. The operator carries it to
// CounterAudit, which checks it against the reviewers the review log establishes; it cannot be
// spent on any other request.
import { createHash, createPrivateKey, sign, verify } from "node:crypto";
import {
  canonicalizeJson,
  decodeCanonicalBase64url,
  isRecord,
  parsePublicKey,
} from "./outcomeProof";
import { REVIEWER_ID } from "./reviewLog";

export const KEY_APPROVAL_SCHEMA = "agent-bureau/key-approval/v1";
export const APPROVABLE_OPERATIONS = [
  "create_key",
  "revoke_key",
  "set_review_org",
] as const;
export type ApprovableOperation = (typeof APPROVABLE_OPERATIONS)[number];

const SIGNING_CONTEXT = `${KEY_APPROVAL_SCHEMA}\n`;
const SIGNATURE_PREFIX = "ed25519:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DECIDED_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const FIELDS = [
  "schema",
  "reviewer_id",
  "org_id",
  "request_id",
  "operation",
  "payload_sha256",
  "decided_at",
  "signature",
];

export type KeyApproval = {
  schema: typeof KEY_APPROVAL_SCHEMA;
  reviewer_id: string;
  org_id: string;
  request_id: string;
  operation: ApprovableOperation;
  // SHA-256 (hex) of the request's payload in RFC 8785 canonical JSON.
  payload_sha256: string;
  decided_at: string;
  signature: string;
};

/** SHA-256 (hex) of an approval request's payload, as an approval names it. */
export function payloadDigest(payload: unknown): string {
  return createHash("sha256").update(canonicalizeJson(payload), "utf8").digest("hex");
}

/** Checks an approval's form; its signature is checked by whoever knows the reviewer's key. */
export function checkKeyApprovalForm(
  value: unknown
): { ok: true; approval: KeyApproval } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!isRecord(value)) return fail("not a JSON object");
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.length || !FIELDS.every(f => keys.includes(f))) {
    return fail(`fields must be exactly ${FIELDS.join(", ")}`);
  }
  if (value.schema !== KEY_APPROVAL_SCHEMA) return fail(`schema is not ${KEY_APPROVAL_SCHEMA}`);
  if (typeof value.reviewer_id !== "string" || !REVIEWER_ID.test(value.reviewer_id)) {
    return fail("reviewer_id must look like rev_ and 3 to 32 lowercase letters or digits");
  }
  if (typeof value.org_id !== "string" || !UUID.test(value.org_id)) {
    return fail("org_id must be a lowercase UUID");
  }
  if (typeof value.request_id !== "string" || !UUID.test(value.request_id)) {
    return fail("request_id must be a lowercase UUID");
  }
  if (!APPROVABLE_OPERATIONS.includes(value.operation as ApprovableOperation)) {
    return fail(`operation must be one of ${APPROVABLE_OPERATIONS.join(", ")}`);
  }
  if (typeof value.payload_sha256 !== "string" || !SHA256_HEX.test(value.payload_sha256)) {
    return fail("payload_sha256 must be 64 lowercase hex characters");
  }
  if (
    typeof value.decided_at !== "string" ||
    !DECIDED_AT.test(value.decided_at) ||
    Number.isNaN(Date.parse(value.decided_at))
  ) {
    return fail("decided_at must be an ISO time in UTC with milliseconds");
  }
  if (
    typeof value.signature !== "string" ||
    !value.signature.startsWith(SIGNATURE_PREFIX) ||
    !decodeCanonicalBase64url(value.signature.slice(SIGNATURE_PREFIX.length), 64)
  ) {
    return fail("the signature is not 64 bytes of canonical base64url");
  }
  return { ok: true, approval: value as KeyApproval };
}

function signingPayload(unsigned: Record<string, unknown>): Buffer {
  return Buffer.from(SIGNING_CONTEXT + canonicalizeJson(unsigned), "utf8");
}

/** Signs an approval with the reviewer's private key (PKCS#8 PEM). */
export function signKeyApproval(
  unsigned: Omit<KeyApproval, "signature">,
  privateKeyPem: string
): KeyApproval {
  const signature = sign(null, signingPayload(unsigned), createPrivateKey(privateKeyPem));
  return { ...unsigned, signature: `${SIGNATURE_PREFIX}${signature.toString("base64url")}` };
}

/** Whether a well-formed approval's signature checks with a public key. */
export function keyApprovalVerifies(approval: KeyApproval, publicKeyText: string): boolean {
  const bytes = decodeCanonicalBase64url(approval.signature.slice(SIGNATURE_PREFIX.length), 64);
  if (!bytes) return false;
  try {
    const { signature: _signature, ...unsigned } = approval;
    return verify(null, signingPayload(unsigned), parsePublicKey(publicKeyText), bytes);
  } catch {
    return false;
  }
}
