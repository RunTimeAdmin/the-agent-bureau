// For tests only: CounterAudit's chain checkpoints, signed the way its exportSigningService signs
// them (eddsa-jcs-2022), with a key made for the test run. A test file that reads the review log
// adds TEST_EXPORT_KEY to the pinned keys with vi.mock("./counterauditKeys"); production pins
// CounterAudit's own key only (server/counterauditKeys.ts).
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { canonicalizeJson } from "./outcomeProof";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KID = "test-export-ed25519";

export const TEST_EXPORT_KEY = {
  kty: "OKP" as const,
  crv: "Ed25519" as const,
  kid: KID,
  x: String(publicKey.export({ format: "jwk" }).x),
};

const sha256 = (value: unknown) => createHash("sha256").update(canonicalizeJson(value), "utf8").digest();

/** `payload` with a signature block as CounterAudit attaches one. */
export function signedByTestKey(payload: Record<string, unknown>, signedAt = "2026-11-03T12:00:00.000Z") {
  const proof = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    created: signedAt,
    verificationMethod: `/.well-known/counteraudit-export-jwk.json#${KID}`,
    proofPurpose: "assertionMethod",
  };
  const signature = sign(null, Buffer.concat([sha256(proof), sha256(payload)]), privateKey);
  return {
    ...payload,
    signature: {
      algorithm: "eddsa-jcs-2022",
      digest: sha256(payload).toString("hex"),
      signature: `z${bs58.encode(signature)}`,
      key_id: KID,
      verification_key_url: "/.well-known/counteraudit-export-jwk.json",
      verification_method: "eddsa_jcs_2022_jwks",
      signed_at: signedAt,
      proof,
    },
  };
}

/** A signed checkpoint for the packet at the tip of a chain. */
export function checkpointOf(orgId: string, tip: { sequence: number; entryHash: string; packetId: string }) {
  return signedByTestKey({
    checkpoint_type: "counteraudit.chain_checkpoint",
    checkpoint_version: 1,
    org_id: orgId,
    sequence: tip.sequence,
    entry_hash: tip.entryHash,
    packet_id: tip.packetId,
    issued_at: "2026-11-03T12:00:00.000Z",
  });
}

/** CounterAudit's answer to GET /v1/audit/chain/:org_id/checkpoint for a chain with this tip. */
export function checkpointResponse(
  orgId: string,
  tip: { sequence: number; entryHash: string; packetId: string } | null
): Response {
  if (!tip) {
    return Response.json({ error: "not_found", message: "No checkpoint yet: the chain has no numbered packets." }, { status: 404 });
  }
  return Response.json({ checkpoint: checkpointOf(orgId, tip) });
}
