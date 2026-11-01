// The shared test vectors for subject dispute records (docs/disputes.md):
// server/fixtures/dispute-vectors/dispute-records-v1.json. CounterAudit's
// agent-bureau-dispute-v1 connector checks the same form as checkDisputeForm in
// server/dispute.ts; it copies this file and runs the same cases. Valid records
// carry real signatures from fixed test keys, whose public halves the file
// lists; each invalid record breaks one rule, named as checkDisputeForm names
// it. server/disputeVectors.test.ts checks both, and that the file is what this
// script builds. Rebuild with: pnpm dispute:vectors
//
// The keys are test keys derived from fixed seeds, never used for anything else.
// Ed25519 and EIP-191 (RFC 6979) signatures are deterministic, so the file is
// the same on every run.
import { createHash, createPrivateKey } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import {
  DISPUTE_CONNECTOR_ID,
  DISPUTE_SCHEMA,
  DISPUTE_SIGNING_CONTEXT,
  disputeSigningPayload,
  signWithFurnisherKey,
  signWithWallet,
  walletAddress,
} from "../server/dispute";
import { reviewerPublicKey } from "../server/reviewDecision";

export const VECTORS_PATH = path.join(
  "server",
  "fixtures",
  "dispute-vectors",
  "dispute-records-v1.json"
);

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const seed = (name: string) =>
  createHash("sha256").update(`agent-bureau dispute vectors ${name}`).digest();

function furnisherKey(name: string) {
  const privateKeyPem = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed(name)]),
    format: "der",
    type: "pkcs8",
  })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  return { privateKeyPem, publicKey: reviewerPublicKey(privateKeyPem) };
}

const walletKey = (name: string) => `0x${seed(name).toString("hex")}` as Hex;

export type WalletKey = { type: "eip191"; address: string };
export type FurnisherKey = {
  type: "ed25519";
  furnisher_id: string;
  key_id: string;
  public_key: string;
};
export type DisputeVectors = {
  description: string;
  schema: string;
  connector_id: string;
  signing_context: string;
  keys: { subject: WalletKey; furnisher: FurnisherKey };
  valid: {
    id: string;
    signed_by: "subject" | "furnisher";
    signing_payload: string;
    record: Record<string, unknown>;
  }[];
  invalid: { id: string; rule: string; record: unknown }[];
};

const DISPUTE_ID = "3f2b8c1d-6a4e-4f9b-9c2d-7e8f9a0b1c2d";
const FURNISHER_ID = "fur_vectors01";
const KEY_ID = "vectors-key-1";
const LINE = {
  furnisher_id: FURNISHER_ID,
  event_id: "vectors-event-1",
  signed_event_hash: "ab".repeat(32),
};

export async function buildDisputeVectors(): Promise<DisputeVectors> {
  const subjectKey = walletKey("subject");
  const subject = walletAddress(subjectKey);
  const furnisher = furnisherKey("furnisher");
  const signer = { type: "eip191", address: subject };

  const byWallet = (record: Record<string, unknown>) =>
    signWithWallet({ schema: DISPUTE_SCHEMA, ...record }, subjectKey);
  const byFurnisher = (record: Record<string, unknown>) =>
    signWithFurnisherKey(
      { schema: DISPUTE_SCHEMA, ...record },
      furnisher.privateKeyPem
    );

  const dispute = await byWallet({
    kind: "dispute",
    dispute_id: DISPUTE_ID,
    line: LINE,
    subject_ref: { wallet: subject },
    signer,
    reason: "I never received this payment request.",
    filed_at: "2026-11-01T10:00:00.000Z",
  });
  const response = byFurnisher({
    kind: "response",
    dispute_id: DISPUTE_ID,
    furnisher_id: FURNISHER_ID,
    key_id: KEY_ID,
    response: "confirm",
    evidence: [{ tx_hash: `0x${"cd".repeat(32)}` }],
    responded_at: "2026-11-03T09:30:00.000Z",
  });
  const statement = await byWallet({
    kind: "statement",
    dispute_id: DISPUTE_ID,
    signer,
    text: "The transfer went to a wallet I do not control.",
    stated_at: "2026-11-04T08:00:00.000Z",
  });
  const subjectAppeal = await byWallet({
    kind: "appeal",
    dispute_id: DISPUTE_ID,
    party: "subject",
    signer,
    reason: "The furnisher's evidence shows another wallet.",
    appealed_at: "2026-11-05T12:00:00.000Z",
  });
  const furnisherAppeal = byFurnisher({
    kind: "appeal",
    dispute_id: DISPUTE_ID,
    party: "furnisher",
    furnisher_id: FURNISHER_ID,
    key_id: KEY_ID,
    corrective_event_id: "vectors-event-1-corrected",
    reason: "We missed the deadline; the corrected line is attached.",
    appealed_at: "2026-11-20T12:00:00.000Z",
  });

  const valid: DisputeVectors["valid"] = [];
  const add = (
    id: string,
    signedBy: "subject" | "furnisher",
    record: Record<string, unknown>
  ) =>
    valid.push({
      id,
      signed_by: signedBy,
      signing_payload: disputeSigningPayload(record).toString("utf8"),
      record,
    });
  add("dispute", "subject", dispute);
  add(
    "dispute_with_evidence",
    "subject",
    await byWallet({
      ...dispute,
      evidence: [
        { tx_hash: `0x${"ef".repeat(32)}` },
        { url: "https://example.com/receipts/1" },
        { note: "My bank statement for that week shows nothing." },
      ],
    })
  );
  add(
    "dispute_did_sigvara_subject",
    "subject",
    await byWallet({
      ...dispute,
      subject_ref: { did: `did:sigvara:5042002:${subject.toLowerCase()}` },
    })
  );
  add(
    "dispute_reason_500_characters",
    "subject",
    await byWallet({ ...dispute, reason: "x".repeat(500) })
  );
  add(
    "dispute_non_ascii_reason",
    "subject",
    await byWallet({
      ...dispute,
      reason: "Zahlung nie erhalten: Überweisung fehlt",
    })
  );
  add(
    "dispute_subject_ref_1024_bytes",
    "subject",
    await byWallet({
      ...dispute,
      subject_ref: { did: `did:example:${"a".repeat(1002)}` },
    })
  );
  add("response", "furnisher", response);
  add(
    "response_five_evidence_items",
    "furnisher",
    byFurnisher({
      ...response,
      evidence: [
        { tx_hash: `0x${"cd".repeat(32)}` },
        { tx_hash: `0x${"CD".repeat(32)}` },
        { url: "https://example.com/logs/delivery?id=7" },
        { note: "Delivery confirmed by the provider log." },
        { note: "n" },
      ],
    })
  );
  add("statement", "subject", statement);
  add("appeal_by_subject", "subject", subjectAppeal);
  add("appeal_by_furnisher", "furnisher", furnisherAppeal);

  const without = (record: Record<string, unknown>, field: string) => {
    const { [field]: _dropped, ...rest } = record;
    return rest;
  };
  const sig = String(response.signature);
  const lastChar = sig.at(-1) as string;
  // The next character decodes to the same 64 bytes, with spare bits set.
  const noncanonical = `${sig.slice(0, -1)}${String.fromCharCode(lastChar.charCodeAt(0) + 1)}`;
  const invalid: DisputeVectors["invalid"] = [
    { id: "not_an_object", rule: "not a JSON object", record: [dispute] },
    {
      id: "schema_v2",
      rule: "schema is not agent-bureau/dispute/v1",
      record: { ...dispute, schema: "agent-bureau/dispute/v2" },
    },
    {
      id: "unknown_kind",
      rule: "kind is not dispute, response, statement or appeal",
      record: { ...dispute, kind: "withdrawal" },
    },
    {
      id: "appeal_unknown_party",
      rule: "party is not subject or furnisher",
      record: { ...subjectAppeal, party: "operator" },
    },
    {
      id: "extra_field",
      rule: "unexpected field note",
      record: { ...dispute, note: "extra" },
    },
    {
      id: "missing_reason",
      rule: "missing field reason",
      record: without(dispute, "reason"),
    },
    {
      id: "missing_signature",
      rule: "missing field signature",
      record: without(dispute, "signature"),
    },
    {
      id: "dispute_id_uppercase",
      rule: "dispute_id is not a lowercase UUID",
      record: { ...dispute, dispute_id: DISPUTE_ID.toUpperCase() },
    },
    {
      id: "dispute_id_not_uuid",
      rule: "dispute_id is not a lowercase UUID",
      record: { ...dispute, dispute_id: "dispute-1" },
    },
    {
      id: "filed_at_without_milliseconds",
      rule: "filed_at is not a UTC time with milliseconds",
      record: { ...dispute, filed_at: "2026-11-01T10:00:00Z" },
    },
    {
      id: "filed_at_with_offset",
      rule: "filed_at is not a UTC time with milliseconds",
      record: { ...dispute, filed_at: "2026-11-01T10:00:00.000+00:00" },
    },
    {
      id: "line_not_object",
      rule: "line is not an object",
      record: { ...dispute, line: "fur_vectors01/vectors-event-1" },
    },
    {
      id: "line_extra_field",
      rule: "unexpected field line.outcome",
      record: { ...dispute, line: { ...LINE, outcome: "paid" } },
    },
    {
      id: "line_missing_hash",
      rule: "missing field line.signed_event_hash",
      record: { ...dispute, line: without(LINE, "signed_event_hash") },
    },
    {
      id: "line_furnisher_id_uppercase",
      rule: "line.furnisher_id is not a furnisher id",
      record: { ...dispute, line: { ...LINE, furnisher_id: "fur_VECTORS01" } },
    },
    {
      id: "line_event_id_with_space",
      rule: "line.event_id is not an event id",
      record: { ...dispute, line: { ...LINE, event_id: "vectors event 1" } },
    },
    {
      id: "line_hash_uppercase",
      rule: "line.signed_event_hash is not 64 lowercase hex characters",
      record: {
        ...dispute,
        line: { ...LINE, signed_event_hash: "AB".repeat(32) },
      },
    },
    {
      id: "subject_ref_not_object",
      rule: "subject_ref is not an object",
      record: { ...dispute, subject_ref: subject },
    },
    {
      id: "subject_ref_1025_bytes",
      rule: "subject_ref is over 1024 bytes as canonical JSON",
      record: {
        ...dispute,
        subject_ref: { did: `did:example:${"a".repeat(1003)}` },
      },
    },
    {
      id: "signer_not_eip191",
      rule: "signer.type is not eip191",
      record: { ...dispute, signer: { type: "eip712", address: subject } },
    },
    {
      id: "signer_extra_field",
      rule: "unexpected field signer.chain_id",
      record: { ...dispute, signer: { ...signer, chain_id: 1 } },
    },
    {
      id: "signer_short_address",
      rule: "signer.address is not 0x and 40 hex characters",
      record: {
        ...dispute,
        signer: { ...signer, address: subject.slice(0, -1) },
      },
    },
    {
      id: "reason_empty",
      rule: "reason is not 1 to 500 characters, or is blank",
      record: { ...dispute, reason: "" },
    },
    {
      id: "reason_blank",
      rule: "reason is not 1 to 500 characters, or is blank",
      record: { ...dispute, reason: " \n\t " },
    },
    {
      id: "reason_501_characters",
      rule: "reason is not 1 to 500 characters, or is blank",
      record: { ...dispute, reason: "x".repeat(501) },
    },
    {
      id: "evidence_empty",
      rule: "evidence is not a list of 1 to 5 items",
      record: { ...dispute, evidence: [] },
    },
    {
      id: "evidence_six_items",
      rule: "evidence is not a list of 1 to 5 items",
      record: { ...response, evidence: Array(6).fill({ note: "n" }) },
    },
    {
      id: "evidence_two_kinds_in_one_item",
      rule: "evidence[0] is not exactly one of tx_hash, url or note",
      record: {
        ...response,
        evidence: [{ tx_hash: `0x${"cd".repeat(32)}`, note: "and a note" }],
      },
    },
    {
      id: "evidence_unknown_kind",
      rule: "evidence[0] is not exactly one of tx_hash, url or note",
      record: { ...response, evidence: [{ hash: `0x${"cd".repeat(32)}` }] },
    },
    {
      id: "evidence_short_tx_hash",
      rule: "evidence[0].tx_hash is not 0x and 64 hex characters",
      record: { ...response, evidence: [{ tx_hash: `0x${"c".repeat(63)}` }] },
    },
    {
      id: "evidence_http_url",
      rule: "evidence[0].url is not an https URL of at most 500 characters",
      record: { ...response, evidence: [{ url: "http://example.com/logs/1" }] },
    },
    {
      id: "evidence_url_501_characters",
      rule: "evidence[0].url is not an https URL of at most 500 characters",
      record: {
        ...response,
        evidence: [{ url: `https://example.com/${"a".repeat(481)}` }],
      },
    },
    {
      id: "evidence_empty_note",
      rule: "evidence[1].note is not 1 to 500 characters",
      record: { ...response, evidence: [{ note: "ok" }, { note: "" }] },
    },
    {
      id: "response_not_confirm",
      rule: "response is not confirm",
      record: { ...response, response: "deny" },
    },
    {
      id: "response_without_evidence",
      rule: "missing field evidence",
      record: without(response, "evidence"),
    },
    {
      id: "response_key_id_leading_dash",
      rule: "key_id is not a key id",
      record: { ...response, key_id: "-vectors-key-1" },
    },
    {
      id: "response_furnisher_id_short",
      rule: "furnisher_id is not a furnisher id",
      record: { ...response, furnisher_id: "fur_abc" },
    },
    {
      id: "response_signed_by_wallet",
      rule: "signature is not ed25519: and 64 bytes of canonical base64url",
      record: { ...response, signature: dispute.signature },
    },
    {
      id: "response_noncanonical_signature",
      rule: "signature is not ed25519: and 64 bytes of canonical base64url",
      record: { ...response, signature: noncanonical },
    },
    {
      id: "dispute_signed_by_ed25519_key",
      rule: "signature is not 0x and 130 hex characters",
      record: { ...dispute, signature: response.signature },
    },
    {
      id: "dispute_short_signature",
      rule: "signature is not 0x and 130 hex characters",
      record: { ...dispute, signature: String(dispute.signature).slice(0, -2) },
    },
    {
      id: "statement_text_501_characters",
      rule: "text is not 1 to 500 characters, or is blank",
      record: { ...statement, text: "x".repeat(501) },
    },
    {
      id: "statement_with_evidence",
      rule: "unexpected field evidence",
      record: { ...statement, evidence: [{ note: "n" }] },
    },
    {
      id: "appeal_by_subject_with_key_id",
      rule: "unexpected field key_id",
      record: { ...subjectAppeal, key_id: KEY_ID },
    },
    {
      id: "appeal_by_furnisher_without_corrective_line",
      rule: "missing field corrective_event_id",
      record: without(furnisherAppeal, "corrective_event_id"),
    },
    {
      id: "appeal_by_furnisher_bad_corrective_event_id",
      rule: "corrective_event_id is not an event id",
      record: { ...furnisherAppeal, corrective_event_id: "corrected/1" },
    },
    {
      id: "appeal_time_as_number",
      rule: "appealed_at is not a UTC time with milliseconds",
      record: { ...subjectAppeal, appealed_at: 1793700000000 },
    },
  ];

  return {
    description:
      "Shared test vectors for the Agent Bureau's subject dispute records (docs/disputes.md), which CounterAudit seals through the agent-bureau-dispute-v1 connector. valid records pass the form check and carry real signatures: a subject's over EIP-191 personal_sign of signing_payload as raw bytes, by the subject key's address; a furnisher's Ed25519 over the same payload, with the furnisher key. Each invalid record breaks the one rule named. Built by scripts/dispute-vectors.ts in the-agent-bureau. The keys are test keys from fixed seeds.",
    schema: DISPUTE_SCHEMA,
    connector_id: DISPUTE_CONNECTOR_ID,
    signing_context: DISPUTE_SIGNING_CONTEXT,
    keys: {
      subject: { type: "eip191", address: subject },
      furnisher: {
        type: "ed25519",
        furnisher_id: FURNISHER_ID,
        key_id: KEY_ID,
        public_key: furnisher.publicKey,
      },
    },
    valid,
    invalid,
  };
}

/** The file's exact text: two-space JSON and a final newline. */
export async function disputeVectorsText(): Promise<string> {
  return `${JSON.stringify(await buildDisputeVectors(), null, 2)}\n`;
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]).startsWith("dispute-vectors")
) {
  mkdirSync(path.dirname(VECTORS_PATH), { recursive: true });
  writeFileSync(VECTORS_PATH, await disputeVectorsText());
  console.log(`Wrote ${VECTORS_PATH}`);
}
