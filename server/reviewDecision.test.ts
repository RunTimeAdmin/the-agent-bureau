import { describe, expect, it } from "vitest";
import {
  REVIEW_SCHEMA,
  checkReviewDecision,
  newReviewerKey,
  reviewerPublicKey,
  signReviewDecision,
  type ReviewDecision,
} from "./reviewDecision";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const alice = newReviewerKey();
const bob = newReviewerKey();
const REVIEWERS = {
  rev_alice: { name: "Alice", publicKey: alice.publicKey },
  rev_bob: { name: "Bob", publicKey: bob.publicKey },
};

function unsigned(
  overrides: Partial<ReviewDecision> = {}
): Omit<ReviewDecision, "signature"> {
  return {
    schema: REVIEW_SCHEMA,
    reviewer_id: "rev_alice",
    furnisher_id: "fur_levymerchant1",
    event_id: "levy-sub8-charge1",
    signed_event_hash: "ab".repeat(32),
    data_class: "test",
    evidence_digest: "cd".repeat(32),
    decision: "approve",
    decided_at: "2026-10-31T11:59:00.000Z",
    ...overrides,
  };
}

const check = (value: unknown) => checkReviewDecision(value, REVIEWERS, NOW);

describe("signed review decisions", () => {
  it("accepts a decision signed by the listed reviewer's key", () => {
    const decision = signReviewDecision(unsigned(), alice.privateKeyPem);
    expect(check(decision)).toEqual({ ok: true, decision });
    expect(reviewerPublicKey(alice.privateKeyPem)).toBe(alice.publicKey);
  });

  it("refuses a decision signed by another reviewer's key", () => {
    const decision = signReviewDecision(unsigned(), bob.privateKeyPem);
    expect(check(decision)).toEqual({
      ok: false,
      reason: "the signature does not verify with rev_alice's key",
    });
  });

  it("refuses a decision changed after signing", () => {
    const signed = signReviewDecision(unsigned(), alice.privateKeyPem);
    for (const change of [
      { decision: "reject", reason: "changed" },
      { signed_event_hash: "cd".repeat(32) },
      { event_id: "another-event" },
      { decided_at: "2026-10-31T11:59:30.000Z" },
    ]) {
      const result = check({ ...signed, ...change });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a signature with a second spelling of the same bytes", () => {
    const signed = signReviewDecision(unsigned(), alice.privateKeyPem);
    // The last base64url character of 64 bytes carries 4 spare bits.
    const last = signed.signature.at(-1)!;
    const other = last === "A" ? "B" : "A";
    const result = check({
      ...signed,
      signature: signed.signature.slice(0, -1) + other,
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    [
      "an unlisted reviewer",
      { reviewer_id: "rev_mallory" },
      "rev_mallory is not a listed reviewer",
    ],
    [
      "a reject with no reason",
      { decision: "reject" as const },
      "reject needs a reason",
    ],
    [
      "a waiver with no reason",
      { decision: "approve_with_waiver" as const },
      "approve_with_waiver needs a reason",
    ],
    [
      "a decision signed in the future",
      { decided_at: "2026-10-31T12:10:00.000Z" },
      "decided_at is in the future",
    ],
    [
      "a time without milliseconds",
      { decided_at: "2026-10-31T11:59:00Z" },
      "decided_at must be an ISO time in UTC with milliseconds",
    ],
    [
      "an uppercase hash",
      { signed_event_hash: "AB".repeat(32) },
      "signed_event_hash must be 64 lowercase hex characters",
    ],
    [
      "a furnisher id that is not v1",
      { furnisher_id: "levy" },
      "furnisher_id or event_id is not a v1 id",
    ],
  ])("refuses %s", (_name, overrides, reason) => {
    const signed = signReviewDecision(unsigned(overrides), alice.privateKeyPem);
    expect(check(signed)).toEqual({ ok: false, reason });
  });

  it.each([
    [
      "a data class that is not test or live",
      { data_class: "staging" as never },
      "data_class must be test or live",
    ],
    [
      "an evidence digest that is not hex",
      { evidence_digest: "not-a-digest" },
      "evidence_digest must be 64 lowercase hex characters",
    ],
  ])("refuses %s", (_name, overrides, reason) => {
    const signed = signReviewDecision(unsigned(overrides), alice.privateKeyPem);
    expect(check(signed)).toEqual({ ok: false, reason });
  });

  it("re-checks a recorded decision without its time limit", () => {
    const later = signReviewDecision(
      unsigned({ decided_at: "2026-11-30T00:00:00.000Z" }),
      alice.privateKeyPem
    );
    expect(check(later).ok).toBe(false);
    expect(checkReviewDecision(later, REVIEWERS, null).ok).toBe(true);
  });

  it("refuses unexpected fields, even when signed", () => {
    const signed = signReviewDecision(
      { ...unsigned(), note: "extra" } as Omit<ReviewDecision, "signature">,
      alice.privateKeyPem
    );
    expect(check(signed)).toEqual({
      ok: false,
      reason: "unexpected fields: note",
    });
  });

  it("refuses everything from a listed key that is a small-order point", () => {
    const signed = signReviewDecision(unsigned(), alice.privateKeyPem);
    const result = checkReviewDecision(
      signed,
      { rev_alice: { name: "Alice", publicKey: `ed25519:${"A".repeat(43)}` } },
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("listed key is unusable");
  });
});
