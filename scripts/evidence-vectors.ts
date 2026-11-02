// The shared test vectors for evidence records (server/evidenceSeal.ts):
// server/fixtures/evidence-vectors/evidence-records-v1.json. CounterAudit's
// agent-bureau-evidence-v1 connector checks the same form as checkEvidenceRecord;
// it copies this file and runs the same cases. Each invalid record breaks one
// rule, named as checkEvidenceRecord names it. server/evidenceSeal.test.ts checks
// both, and that the file is what this script builds. Rebuild with:
// pnpm evidence:vectors
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_CONNECTOR_ID, EVIDENCE_SCHEMA } from "../server/evidenceSeal";

export const VECTORS_PATH = path.join(
  "server",
  "fixtures",
  "evidence-vectors",
  "evidence-records-v1.json"
);

export type EvidenceVectors = {
  description: string;
  schema: string;
  connector_id: string;
  valid: { id: string; record: Record<string, unknown> }[];
  invalid: { id: string; rule: string; record: unknown }[];
};

const BASE = {
  schema: EVIDENCE_SCHEMA,
  furnisher_id: "fur_vectors01",
  event_id: "6d1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b",
  signed_event_hash: "ab".repeat(32),
  evidence_digest: "cd".repeat(32),
  status: "verified",
  needs_waiver: false,
  checked_at: "2026-11-02T12:00:00.000Z",
};

const without = (field: keyof typeof BASE) => {
  const { [field]: _gone, ...rest } = BASE;
  return rest;
};

export function buildEvidenceVectors(): EvidenceVectors {
  return {
    description:
      "Shared test vectors for the Agent Bureau's evidence records (server/evidenceSeal.ts), which CounterAudit seals through the agent-bureau-evidence-v1 connector in the Bureau's own organization. valid records pass the form check; each invalid record breaks the one rule named. Built by scripts/evidence-vectors.ts in the-agent-bureau.",
    schema: EVIDENCE_SCHEMA,
    connector_id: EVIDENCE_CONNECTOR_ID,
    valid: [
      { id: "verified_plain", record: BASE },
      { id: "needs_review_needs_waiver", record: { ...BASE, status: "needs_review", needs_waiver: true } },
      { id: "verified_with_a_screen_to_waive", record: { ...BASE, needs_waiver: true } },
      { id: "failed", record: { ...BASE, status: "failed", needs_waiver: true } },
      { id: "pending", record: { ...BASE, status: "pending", needs_waiver: true } },
      { id: "error", record: { ...BASE, status: "error", needs_waiver: true } },
      { id: "event_id_from_before_uuids", record: { ...BASE, event_id: "levy-sub8-charge1" } },
    ],
    invalid: [
      { id: "not_an_object", rule: "not a JSON object", record: [BASE] },
      { id: "unknown_field", rule: "unknown field reason", record: { ...BASE, reason: "extra" } },
      { id: "no_schema", rule: "schema is missing", record: without("schema") },
      { id: "no_event_id", rule: "event_id is missing", record: without("event_id") },
      { id: "no_evidence_digest", rule: "evidence_digest is missing", record: without("evidence_digest") },
      { id: "no_needs_waiver", rule: "needs_waiver is missing", record: without("needs_waiver") },
      { id: "no_checked_at", rule: "checked_at is missing", record: without("checked_at") },
      {
        id: "another_schema",
        rule: `schema is not ${EVIDENCE_SCHEMA}`,
        record: { ...BASE, schema: "agent-bureau/evidence-result/v2" },
      },
      {
        id: "furnisher_id_not_fur",
        rule: "furnisher_id is not a furnisher id (fur_...)",
        record: { ...BASE, furnisher_id: "levymerchant1" },
      },
      {
        id: "event_id_with_a_space",
        rule: "event_id is not an event id",
        record: { ...BASE, event_id: "charge 1" },
      },
      {
        id: "signed_event_hash_uppercase",
        rule: "signed_event_hash is not 64 lowercase hex characters",
        record: { ...BASE, signed_event_hash: "AB".repeat(32) },
      },
      {
        id: "evidence_digest_short",
        rule: "evidence_digest is not 64 lowercase hex characters",
        record: { ...BASE, evidence_digest: "cd".repeat(31) },
      },
      {
        id: "status_unknown",
        rule: "status is not one of verified, failed, needs_review, pending, error",
        record: { ...BASE, status: "waived" },
      },
      {
        id: "needs_waiver_text",
        rule: "needs_waiver is not true or false",
        record: { ...BASE, needs_waiver: "false" },
      },
      {
        id: "checked_at_without_milliseconds",
        rule: "checked_at is not a UTC time with milliseconds",
        record: { ...BASE, checked_at: "2026-11-02T12:00:00Z" },
      },
      {
        id: "checked_at_with_an_offset",
        rule: "checked_at is not a UTC time with milliseconds",
        record: { ...BASE, checked_at: "2026-11-02T13:00:00.000+01:00" },
      },
      {
        id: "checked_at_not_a_day",
        rule: "checked_at is not a UTC time with milliseconds",
        record: { ...BASE, checked_at: "2026-02-30T12:00:00.000Z" },
      },
    ],
  };
}

/** The file's exact text: two-space JSON and a final newline. */
export function evidenceVectorsText(): string {
  return `${JSON.stringify(buildEvidenceVectors(), null, 2)}\n`;
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]).startsWith("evidence-vectors")
) {
  mkdirSync(path.dirname(VECTORS_PATH), { recursive: true });
  writeFileSync(VECTORS_PATH, evidenceVectorsText());
  console.log(`Wrote ${VECTORS_PATH}`);
}
