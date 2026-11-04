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

type Listed = { packet_id: string; sequence?: unknown };

/**
 * A whole chain for a test organization: these packets at their sequences, an ordinary packet at
 * each sequence between, and every one linked to the one before by entry hash, as CounterAudit
 * lists them. A packet with no sequence it can be placed at is kept after the chain, unlinked.
 */
export function chainOf<T extends Listed>(orgId: string, packets: T[]) {
  const hashAt = (sequence: number) => createHash("sha256").update(`${orgId}:${sequence}`).digest("hex");
  const placed = new Map<number, T>();
  for (const p of packets) {
    const sequence = Number(p.sequence);
    if (p.sequence !== undefined && Number.isSafeInteger(sequence) && sequence >= 0) placed.set(sequence, p);
  }
  const top = Math.max(-1, ...placed.keys());
  const chain: Array<(T | { packet_id: string; org_id: string; connector_id: string; sequence: number; created_at: string }) & {
    prev_hash: string;
    entry_hash: string;
    integrity: { prev_hash: string; entry_hash: string };
  }> = [];
  for (let sequence = 0; sequence <= top; sequence++) {
    const filler = createHash("sha256").update(`filler:${orgId}:${sequence}`).digest("hex");
    const packet = placed.get(sequence) ?? {
      packet_id: `${filler.slice(0, 8)}-${filler.slice(8, 12)}-4${filler.slice(13, 16)}-8${filler.slice(17, 20)}-${filler.slice(20, 32)}`,
      org_id: orgId,
      connector_id: "an-ordinary-connector",
      sequence,
      created_at: "2026-11-02T00:00:00.000Z",
    };
    const prev_hash = sequence === 0 ? "0".repeat(64) : hashAt(sequence - 1);
    const entry_hash = hashAt(sequence);
    // The listing's hashes at the top, and the verify route's in `integrity`.
    chain.push({ ...packet, prev_hash, entry_hash, integrity: { prev_hash, entry_hash } });
  }
  const unplaced = packets.filter(p => !Object.values(Object.fromEntries(placed)).includes(p));
  return {
    packets: [...chain, ...unplaced],
    tip: top < 0 ? null : { sequence: top, entryHash: hashAt(top), packetId: chain[top].packet_id },
  };
}

/**
 * A signed head attestation over a reader's nonce, as CounterAudit gives one with
 * GET /v1/audit/chain/:org_id/checkpoint?nonce=, naming the checkpoint for this tip (or an empty
 * chain) as the head now. `fields` replaces any of them.
 */
export function attestationOf(
  orgId: string,
  tip: { sequence: number; entryHash: string; packetId: string } | null,
  nonce: string | null,
  fields: Record<string, unknown> = {}
) {
  return signedByTestKey({
    attestation_type: "counteraudit.chain_head_attestation",
    attestation_version: 1,
    org_id: orgId,
    nonce,
    // The reader holds this to the time its request took, by its own clock.
    served_at: new Date().toISOString(),
    tip_sequence: tip ? tip.sequence : null,
    checkpoint_sequence: tip ? tip.sequence : null,
    checkpoint_entry_hash: tip ? tip.entryHash : null,
    checkpoint_packet_id: tip ? tip.packetId : null,
    checkpoint_issued_at: tip ? "2026-11-03T12:00:00.000Z" : null,
    current: true,
    ...fields,
  });
}

/**
 * CounterAudit's answer to GET /v1/audit/chain/:org_id/checkpoint for a chain with this tip, with a
 * head attestation over the nonce the request sent.
 */
export function checkpointResponse(
  orgId: string,
  tip: { sequence: number; entryHash: string; packetId: string } | null,
  nonce: string | null
): Response {
  const attestation = { attestation: attestationOf(orgId, tip, nonce) };
  if (!tip) {
    return Response.json(
      { error: "not_found", message: "No checkpoint yet: the chain has no numbered packets.", ...attestation },
      { status: 404 }
    );
  }
  return Response.json({ checkpoint: checkpointOf(orgId, tip), ...attestation });
}
