import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROOF_CHECKS,
  signedEventHash,
  verifyOutcomeProof,
  type Jwks,
  type ProofCheckName,
} from "./outcomeProof";

// Real CounterAudit output, captured from production on 2026-10-30: the public
// proof of packet 6a311b56-..., sealed in a test org from an event signed by
// agent-bureau-furnish with a throwaway test key, and CounterAudit's export
// JWKS. None of it is secret.
const fixtures = path.resolve(import.meta.dirname, "fixtures", "counteraudit");
const read = (name: string) => readFileSync(path.join(fixtures, name), "utf8");

const TEST_ORG = "71689063-29f4-4d83-89a7-1d8f7fbaaf87";
const PACKET_ID = "6a311b56-bf03-43cd-86b2-9357f5685080";

const proof = JSON.parse(read("proof.json")) as Record<string, unknown>;
const jwks = JSON.parse(read("jwks.json")) as Jwks;
const event = JSON.parse(read("signed.jsonl").trim()) as Record<
  string,
  unknown
>;

function failed(result: ReturnType<typeof verifyOutcomeProof>) {
  return PROOF_CHECKS.filter(name => !result.checks[name].ok);
}

function verifyWith(
  overrides: Partial<Parameters<typeof verifyOutcomeProof>[0]> = {}
) {
  return verifyOutcomeProof({
    proof,
    event,
    jwks,
    orgId: TEST_ORG,
    packetId: PACKET_ID,
    ...overrides,
  });
}

describe("verifyOutcomeProof against real CounterAudit output", () => {
  it("passes every check for the sealed event in the Bureau's org", () => {
    const result = verifyWith();
    expect(failed(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.checks).sort()).toEqual([...PROOF_CHECKS].sort());
  });

  it("matches CounterAudit's signed_event_hash for the event", () => {
    expect(signedEventHash(event)).toBe(
      (proof.outcome_claim as { signed_event_hash: string }).signed_event_hash
    );
  });

  it("fails only the org check when another org is expected", () => {
    const result = verifyWith({
      orgId: "00000000-0000-4000-8000-000000000000",
    });
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual<ProofCheckName[]>(["org_id"]);
    expect(result.checks.org_id.detail).toContain(TEST_ORG);
  });

  it("fails the hash and signature checks when the event is changed", () => {
    const result = verifyWith({
      event: { ...event, occurred_at: "2026-10-30T18:54:50Z" },
    });
    expect(failed(result)).toEqual<ProofCheckName[]>([
      "signed_event_hash",
      "event_signature",
    ]);
  });

  it("fails the proof signature when a proof field is tampered with", () => {
    const result = verifyWith({
      proof: { ...proof, created_at: "2026-10-30T18:55:05.529Z" },
    });
    expect(failed(result)).toEqual<ProofCheckName[]>(["proof_signature"]);
    expect(result.checks.proof_signature.detail).toContain("digest_mismatch");
  });

  it("fails the proof signature when the digest is recomputed but the signature is not", () => {
    // A forger who also rewrites the digest still cannot produce the signature.
    const tampered = { ...proof, sequence: 1 };
    const signature = {
      ...(proof.signature as Record<string, unknown>),
      digest: undefined,
    };
    const result = verifyWith({ proof: { ...tampered, signature } });
    expect(failed(result)).toEqual<ProofCheckName[]>(["proof_signature"]);
    expect(result.checks.proof_signature.detail).toContain("signature_invalid");
  });

  it("fails the proof signature when the JWKS lacks the signing key", () => {
    const result = verifyWith({ jwks: { keys: [] } });
    expect(failed(result)).toEqual<ProofCheckName[]>(["proof_signature"]);
    expect(result.checks.proof_signature.detail).toContain(
      "missing_public_key"
    );
  });

  it("fails the packet check for a different packet id", () => {
    const result = verifyWith({
      packetId: "11111111-1111-4111-8111-111111111111",
    });
    expect(failed(result)).toEqual<ProofCheckName[]>(["packet_id"]);
  });

  it("reports every check as failed, without throwing, for a non-proof", () => {
    const result = verifyWith({ proof: "not a proof" });
    expect(result.ok).toBe(false);
    expect(failed(result)).toEqual([...PROOF_CHECKS]);
  });
});
