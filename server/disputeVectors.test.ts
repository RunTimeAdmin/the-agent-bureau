import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VECTORS_PATH,
  disputeVectorsText,
  type DisputeVectors,
} from "../scripts/dispute-vectors";
import {
  checkDisputeForm,
  disputeSigningPayload,
  furnisherSignatureVerifies,
  walletSignatureVerifies,
  type FurnisherRecord,
  type WalletRecord,
} from "./dispute";

// The dispute records' shared vectors, which CounterAudit's agent-bureau-dispute-v1 connector
// runs against its own form check. Line endings normalized, so a checkout that writes CRLF still
// matches.
const text = readFileSync(VECTORS_PATH, "utf8").replace(/\r\n/g, "\n");
const vectors = JSON.parse(text) as DisputeVectors;

describe("the dispute records' shared vectors", () => {
  it("are what scripts/dispute-vectors.ts builds (rebuild with pnpm dispute:vectors)", async () => {
    expect(text).toBe(await disputeVectorsText());
  });

  it("cover every kind, and both parties' appeals", () => {
    const kinds = vectors.valid.map(v =>
      v.record.kind === "appeal" ? `appeal_${v.record.party}` : v.record.kind
    );
    for (const kind of [
      "dispute",
      "response",
      "statement",
      "appeal_subject",
      "appeal_furnisher",
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  it.each(vectors.valid.map(v => [v.id, v] as const))(
    "valid: %s passes the form check, and its signature verifies with the named key",
    async (_id, v) => {
      const form = checkDisputeForm(v.record);
      expect(form).toEqual({ ok: true, record: v.record });
      expect(disputeSigningPayload(v.record).toString("utf8")).toBe(
        v.signing_payload
      );
      if (v.signed_by === "subject") {
        const record = v.record as WalletRecord;
        expect(record.signer.address).toBe(vectors.keys.subject.address);
        expect(await walletSignatureVerifies(record)).toBe(true);
      } else {
        const record = v.record as FurnisherRecord;
        expect(record.key_id).toBe(vectors.keys.furnisher.key_id);
        expect(
          furnisherSignatureVerifies(record, vectors.keys.furnisher.public_key)
        ).toBe(true);
      }
    }
  );

  it.each(vectors.invalid.map(v => [v.id, v] as const))(
    "invalid: %s breaks the rule it names",
    (_id, v) => {
      expect(checkDisputeForm(v.record)).toEqual({ ok: false, reason: v.rule });
    }
  );
});
