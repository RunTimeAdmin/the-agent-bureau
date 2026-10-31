import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VECTORS_PATH,
  reviewVectorsText,
  type ExpectedReviewer,
  type ReviewVectors,
} from "../scripts/review-vectors";
import {
  checkKeyApprovalForm,
  keyApprovalVerifies,
  payloadDigest,
} from "./keyApproval";
import { replayReviewLog } from "./reviewLog";

// The review log's shared vectors, which CounterAudit copies pinned by SHA-256 and runs
// against its own port of the rules. Line endings normalized, so a checkout that writes CRLF
// still matches.
const text = readFileSync(VECTORS_PATH, "utf8").replace(/\r\n/g, "\n");
const vectors = JSON.parse(text) as ReviewVectors;

describe("the review log's shared vectors", () => {
  it("are what scripts/review-vectors.ts builds (rebuild with pnpm review:vectors)", () => {
    expect(text).toBe(reviewVectorsText());
  });

  it.each(vectors.review_log.map(c => [c.id, c] as const))(
    "review log: %s",
    (_id, c) => {
      const log = replayReviewLog(
        c.records.map(r => ({
          sequence: r.sequence,
          packetId: `packet-${r.sequence}`,
          sealedAt: new Date(r.sealed_at),
          record: r.record,
        })),
        c.pinned_genesis
      );
      const got: Record<string, ExpectedReviewer> | null = log.reviewers
        ? Object.fromEntries(
            [...log.reviewers.entries()].map(([id, r]) => [
              id,
              { name: r.name, public_key: r.publicKey, status: r.status },
            ])
          )
        : null;
      expect(got).toEqual(c.expect.reviewers);
    }
  );

  it.each(vectors.key_approvals.map(c => [c.id, c] as const))(
    "key approval: %s",
    (_id, c) => {
      const form = checkKeyApprovalForm(c.approval);
      expect(form.ok ? "valid" : "invalid").toBe(c.expect.form);
      expect(
        form.ok
          ? keyApprovalVerifies(form.approval, vectors.keys[c.verify_with].public_key)
            ? "valid"
            : "invalid"
          : null
      ).toBe(c.expect.signature);
      expect(payloadDigest(c.payload)).toBe(c.expect.payload_sha256);
      expect(
        (c.approval as { payload_sha256?: string }).payload_sha256 === c.expect.payload_sha256
      ).toBe(c.expect.payload_matches);
    }
  );
});
