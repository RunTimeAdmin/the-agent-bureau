// Checks CounterAudit's public proof for a furnished outcome event. Pure: the
// caller fetches the proof and CounterAudit's export keys (JWKS) and passes
// them in, so nothing here touches the network.
//
// The two signature checks are ports of CounterAudit's own code
// (RunTimeAdmin/CounterAudit, main), kept as close to line for line as
// TypeScript allows so both sides agree on every byte:
// - the proof's signature: verifyExportSignature in
//   src/services/exportSigningService.js, with the eddsa-jcs-2022 helpers it
//   calls in src/utils/dataIntegrityProof.js;
// - the furnisher's signature on the event: verifySignatureV1, parsePublicKey
//   and signedEventHash in src/services/furnishOutcomeEvent.js, which in turn
//   match verifyEventV1 in agent-bureau-furnish.
// Both use the same canonicalize (RFC 8785) and bs58 packages CounterAudit
// uses.
import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from "node:crypto";
import bs58 from "bs58";
import canonicalize from "canonicalize";

export const FURNISH_CONNECTOR_ID = "agent-bureau-outcome-v1";

type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Jwk = Json;
export type Jwks = { keys: Jwk[] };

// ---- src/utils/dataIntegrityProof.js ----

function canonicalizeJson(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new Error("Value is not JSON-LD canonicalizable");
  }
  return canonical;
}

function hashCanonicalBytes(value: unknown): Buffer {
  const canonical = canonicalizeJson(value);
  return createHash("sha256").update(canonical, "utf8").digest();
}

function buildProofConfig(
  proofOptions: unknown,
  unsecuredDocument: Json
): Json {
  if (!isRecord(proofOptions)) {
    throw new Error("proofOptions is required");
  }
  const proofConfig: Json = {
    type: proofOptions.type,
    cryptosuite: proofOptions.cryptosuite,
    created: proofOptions.created,
    verificationMethod: proofOptions.verificationMethod,
    proofPurpose: proofOptions.proofPurpose,
  };
  const context = proofOptions["@context"] ?? unsecuredDocument?.["@context"];
  if (context !== undefined) {
    proofConfig["@context"] = context;
  }
  return proofConfig;
}

// W3C eddsa-jcs-2022 hashData (Section 3.3.4):
// SHA-256(canonical(proofConfig)) || SHA-256(JCS(unsecuredDocument))
function hashEddsaJcs2022Data(proofConfig: Json, unsecuredDocument: Json) {
  const proofConfigHash = hashCanonicalBytes(proofConfig);
  const transformedDocumentHash = hashCanonicalBytes(unsecuredDocument);
  return Buffer.concat([proofConfigHash, transformedDocumentHash]);
}

function decodeMultibaseSignature(proofValue: unknown): Uint8Array {
  if (!proofValue || typeof proofValue !== "string") {
    throw new Error("proofValue must be a non-empty string");
  }
  if (proofValue[0] !== "z") {
    throw new Error(
      "Unsupported multibase encoding (expected base58btc prefix z)"
    );
  }
  return bs58.decode(proofValue.slice(1));
}

function verifyEddsaJcs2022Value(
  unsecuredDocument: Json,
  proofConfig: Json,
  proofValue: unknown,
  publicKeyObject: KeyObject
): boolean {
  try {
    const signature = decodeMultibaseSignature(proofValue);
    const hashData = hashEddsaJcs2022Data(proofConfig, unsecuredDocument);
    return verify(null, hashData, publicKeyObject, signature);
  } catch {
    return false;
  }
}

// ---- src/services/exportSigningService.js ----

const DEFAULT_EXPORT_KEY_ID = "counteraudit-export-ed25519-1";
const ASYMMETRIC_ALGORITHM = "eddsa-jcs-2022";
// What getExportVerificationKeyUrl() returns on a server without
// CA_PUBLIC_VERIFY_URL. Only used for a signature block that carries no
// `proof`, which CounterAudit's current signer always includes.
const DEFAULT_VERIFICATION_KEY_URL =
  "/.well-known/counteraudit-export-jwk.json";

// CounterAudit resolves the key by kid from its own key material. Outside
// CounterAudit, the published JWKS is that key material.
function exportKeyFromJwks(jwks: Jwks, kid: string): KeyObject | null {
  const jwk = jwks.keys.find(key => key.kid === kid);
  if (
    !jwk ||
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string"
  ) {
    return null;
  }
  try {
    return createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      format: "jwk",
    });
  } catch {
    return null;
  }
}

type ExportSignatureResult =
  | { valid: true; key_id: string }
  | { valid: false; reason: string; key_id?: string };

// The eddsa-jcs-2022 branch of verifyExportSignature. Its other branch, a
// legacy HMAC, can only be checked with CounterAudit's shared secret, so a
// block in that form is refused here as unsupported.
function verifyExportSignature(
  payload: Json,
  signatureBlock: unknown,
  jwks: Jwks
): ExportSignatureResult {
  if (!isRecord(signatureBlock)) {
    return { valid: false, reason: "missing_signature" };
  }
  if (signatureBlock.algorithm !== ASYMMETRIC_ALGORITHM) {
    return { valid: false, reason: "unsupported_algorithm" };
  }

  const kid = String(signatureBlock.key_id || DEFAULT_EXPORT_KEY_ID);
  const publicKey = exportKeyFromJwks(jwks, kid);
  if (!publicKey) {
    return { valid: false, reason: "missing_public_key", key_id: kid };
  }

  const digest = hashCanonicalBytes(payload).toString("hex");
  if (signatureBlock.digest && signatureBlock.digest !== digest) {
    return { valid: false, reason: "digest_mismatch", key_id: kid };
  }

  const proofConfig = buildProofConfig(
    signatureBlock.proof || {
      type: "DataIntegrityProof",
      cryptosuite: "eddsa-jcs-2022",
      created: signatureBlock.signed_at,
      verificationMethod: `${signatureBlock.verification_key_url || DEFAULT_VERIFICATION_KEY_URL}#${kid}`,
      proofPurpose: "assertionMethod",
    },
    payload
  );
  const valid = verifyEddsaJcs2022Value(
    payload,
    proofConfig,
    signatureBlock.signature,
    publicKey
  );
  return valid
    ? { valid: true, key_id: kid }
    : { valid: false, reason: "signature_invalid", key_id: kid };
}

// ---- src/services/furnishOutcomeEvent.js ----

// Domain separation, as in the furnisher tool: a v0 signature, or anything
// else the key signed, can never verify as a v1 event.
const SIGNING_CONTEXT_V1 = "agent-bureau/outcome-event/v1\n";
const KEY_PREFIX = "ed25519:";

// The Ed25519 points of small order, and the non-canonical encodings OpenSSL
// still loads for two of them, as libsodium lists them
// (ge25519_has_small_order). Compared without the sign bit. Anyone can forge a
// signature that verifies under such a key, for any event.
const SMALL_ORDER_KEYS = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map(hex => Buffer.from(hex, "hex"));

function isSmallOrderKey(bytes: Buffer): boolean {
  const masked = Buffer.from(bytes);
  masked[31] &= 0x7f;
  return SMALL_ORDER_KEYS.some(key => key.equals(masked));
}

// Base64url text that decodes to `length` bytes and is the only spelling of
// them. The last character carries spare bits, so without this one key or
// signature has several spellings.
function decodeCanonicalBase64url(text: string, length: number): Buffer | null {
  const bytes = Buffer.from(text, "base64url");
  return bytes.length === length && bytes.toString("base64url") === text
    ? bytes
    : null;
}

// A furnisher public key, `ed25519:` and the 43-character base64url JWK x.
function parsePublicKey(text: unknown): KeyObject {
  const value = String(text || "").trim();
  const bytes = value.startsWith(KEY_PREFIX)
    ? decodeCanonicalBase64url(value.slice(KEY_PREFIX.length), 32)
    : null;
  if (!bytes) {
    throw new Error(
      "public_key must look like ed25519:<43 base64url characters>"
    );
  }
  if (isSmallOrderKey(bytes)) {
    throw new Error(
      "public_key is a small-order point, under which anyone could forge a signature"
    );
  }
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: value.slice(KEY_PREFIX.length) },
    format: "jwk",
  });
}

function signingPayloadV1(unsignedEvent: Json): Buffer {
  return Buffer.from(
    SIGNING_CONTEXT_V1 + canonicalizeJson(unsignedEvent),
    "utf8"
  );
}

function verifySignatureV1(event: Json, publicKeyText: unknown): boolean {
  const { signature: sig, ...unsigned } = event;
  // CounterAudit's schema check guarantees the prefix before this runs. The
  // Bureau holds the event without that schema, so it checks here.
  if (typeof sig !== "string" || !sig.startsWith(KEY_PREFIX)) return false;
  // Only the spelling the furnisher tool writes, so one signature is one event
  // to the hashes.
  const bytes = decodeCanonicalBase64url(sig.slice(KEY_PREFIX.length), 64);
  if (!bytes) return false;
  return verify(
    null,
    signingPayloadV1(unsigned),
    parsePublicKey(publicKeyText),
    bytes
  );
}

/** SHA-256 (hex) of the signed event's RFC 8785 canonical JSON. */
export function signedEventHash(event: Json): string {
  return createHash("sha256")
    .update(canonicalizeJson(event), "utf8")
    .digest("hex");
}

// ---- The Bureau's checks ----

export const PROOF_CHECKS = [
  "proof_signature",
  "org_id",
  "connector_id",
  "public_proof",
  "content_verified",
  "packet_id",
  "signed_event_hash",
  "event_signature",
  "signer_matches_event",
] as const;

export type ProofCheckName = (typeof PROOF_CHECKS)[number];
export type CheckResult = { ok: boolean; detail?: string };
export type ProofChecks = Record<ProofCheckName, CheckResult>;
export type ProofVerification = { ok: boolean; checks: ProofChecks };

export type ProofInput = {
  /** The body of GET /v1/proofs/{packet_id}, as fetched. */
  proof: unknown;
  /** The signed event the Bureau holds and sent to CounterAudit. */
  event: Json;
  /** CounterAudit's /.well-known/counteraudit-export-jwk.json. */
  jwks: Jwks;
  /** The Bureau's own CounterAudit organization. */
  orgId: string;
  /** The packet CounterAudit's ingest answer named for this event. */
  packetId: string;
};

const pass: CheckResult = { ok: true };

function fail(detail: string): CheckResult {
  return { ok: false, detail };
}

// A malformed proof must fail its checks, never throw out of verification.
function check(run: () => CheckResult): CheckResult {
  try {
    return run();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function equalsExpected(actual: unknown, expected: unknown): CheckResult {
  if (typeof expected !== "string" || expected === "") {
    return fail("nothing to compare against");
  }
  return actual === expected
    ? pass
    : fail(
        `expected ${JSON.stringify(expected)}, proof has ${JSON.stringify(actual ?? null)}`
      );
}

/**
 * Every check runs and reports on its own; `ok` is true only when all pass.
 * A pass shows that CounterAudit sealed this exact signed event in the
 * Bureau's org and that the furnisher's registered key signed it. It says
 * nothing about whether the outcome happened: that is the evidence policy's
 * job, so a passing line is still shown as unverified.
 */
export function verifyOutcomeProof(input: ProofInput): ProofVerification {
  const proof = isRecord(input.proof) ? input.proof : {};
  const claim = isRecord(proof.outcome_claim) ? proof.outcome_claim : {};
  const signer = isRecord(claim.signer) ? claim.signer : {};
  const { event } = input;

  const checks: ProofChecks = {
    // The proof is the signed payload plus `signature` (withSignature in
    // CounterAudit's packetReceiptService), so the payload is the rest.
    proof_signature: check(() => {
      const { signature, ...payload } = proof;
      const result = verifyExportSignature(payload, signature, input.jwks);
      if (result.valid) return pass;
      return fail(
        result.key_id
          ? `${result.reason} (key ${result.key_id})`
          : result.reason
      );
    }),
    org_id: equalsExpected(proof.org_id, input.orgId),
    connector_id: equalsExpected(proof.connector_id, FURNISH_CONNECTOR_ID),
    public_proof:
      proof.public_proof === true ? pass : fail("public_proof is not true"),
    content_verified:
      proof.content_verified === true
        ? pass
        : fail(
            typeof proof.content_failure === "string"
              ? `content_verified is not true: ${proof.content_failure}`
              : "content_verified is not true"
          ),
    packet_id: equalsExpected(proof.packet_id, input.packetId),
    signed_event_hash: check(() => {
      const hash = signedEventHash(event);
      return claim.signed_event_hash === hash
        ? pass
        : fail(
            `the event hashes to ${hash}, proof has ${JSON.stringify(claim.signed_event_hash ?? null)}`
          );
    }),
    event_signature: check(() =>
      verifySignatureV1(event, signer.public_key)
        ? pass
        : fail(
            "the event's signature does not verify with the proof's signer key"
          )
    ),
    signer_matches_event: check(() => {
      const pairs: Array<[string, unknown, unknown]> = [
        ["furnisher_id", signer.furnisher_id, event.furnisher_id],
        ["key_id", signer.key_id, event.key_id],
        ["event_id", claim.event_id, event.event_id],
      ];
      const mismatched = pairs
        .filter(
          ([, fromProof, fromEvent]) =>
            typeof fromEvent !== "string" ||
            fromEvent === "" ||
            fromProof !== fromEvent
        )
        .map(([name]) => name);
      return mismatched.length === 0
        ? pass
        : fail(`proof and event differ on ${mismatched.join(", ")}`);
    }),
  };

  return { ok: PROOF_CHECKS.every(name => checks[name].ok), checks };
}
