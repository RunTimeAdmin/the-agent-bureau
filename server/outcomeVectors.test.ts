import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROOF_CHECKS,
  parsePublicKey,
  signedEventHash,
  verifyOutcomeProof,
  verifySignatureV1,
  type Jwks,
} from "./outcomeProof";

// The shared outcome event v1 test vectors, built in agent-bureau-furnish
// (vectors/outcome-event-v1.json) and copied here, pinned by SHA-256.
// agent-bureau-furnish and CounterAudit run the same cases. The Bureau checks
// what it checks itself: the furnisher's signature and the signed-event hash
// (CounterAudit refuses schema-invalid events before the Bureau sees them),
// public keys, and CounterAudit's proof. To update: copy the new file from
// agent-bureau-furnish and change VECTORS_SHA256.
const VECTORS_SHA256 =
  "662e1e4ab48130f413bab306fef3bec52eb254f6297358d823baac7ea1c16b0f";

type Json = Record<string, unknown>;
type Vectors = {
  keys: Record<string, { public_key: string }>;
  public_keys: {
    id: string;
    public_key: string;
    expect: "valid" | "invalid";
  }[];
  events: {
    id: string;
    event: Json;
    verify_with: string;
    expect: {
      schema: "valid" | "invalid";
      signature: "valid" | "invalid" | null;
      signed_event_hash: string | null;
    };
  }[];
  proofs: {
    id: string;
    org_id: string;
    packet_id: string;
    event: Json;
    proof: Json;
    jwks: Jwks;
  }[];
};

// Line endings normalized, so a checkout that writes CRLF still matches.
const text = readFileSync(
  path.resolve(
    import.meta.dirname,
    "fixtures",
    "outcome-vectors",
    "outcome-event-v1.json"
  ),
  "utf8"
).replace(/\r\n/g, "\n");
const vectors = JSON.parse(text) as Vectors;

describe("shared outcome event v1 vectors", () => {
  it("are the pinned copy from agent-bureau-furnish", () => {
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(
      VECTORS_SHA256
    );
  });

  const schemaValid = vectors.events.filter(c => c.expect.schema === "valid");
  it.each(schemaValid.map(c => [c.id, c] as const))(
    "event %s: signature and hash",
    (_id, c) => {
      const publicKey = vectors.keys[c.verify_with].public_key;
      expect(verifySignatureV1(c.event, publicKey)).toBe(
        c.expect.signature === "valid"
      );
      expect(signedEventHash(c.event)).toBe(c.expect.signed_event_hash);
    }
  );

  it.each(vectors.public_keys.map(k => [k.id, k] as const))(
    "public key %s",
    (_id, k) => {
      if (k.expect === "valid")
        expect(() => parsePublicKey(k.public_key)).not.toThrow();
      else expect(() => parsePublicKey(k.public_key)).toThrow();
    }
  );

  it.each(vectors.proofs.map(p => [p.id, p] as const))(
    "proof %s passes every check",
    (_id, p) => {
      const result = verifyOutcomeProof({
        proof: p.proof,
        event: p.event,
        jwks: p.jwks,
        orgId: p.org_id,
        packetId: p.packet_id,
      });
      expect(PROOF_CHECKS.filter(name => !result.checks[name].ok)).toEqual([]);
      expect(result.ok).toBe(true);
    }
  );
});
