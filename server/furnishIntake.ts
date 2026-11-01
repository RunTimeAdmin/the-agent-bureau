// Operator intake of signed outcome events: seal each in CounterAudit, check
// its public proof, and record the line. Run by hand through
// scripts/furnish-intake.ts; see docs/counteraudit-intake.md.
//
// Phase 0 limits, enforced here: no public endpoint accepts an outcome (this
// is a script, and no route imports it), and until retention is signed off
// and two-person review exists, only runs marked as test data are accepted.
// A passing proof shows what was sealed and who signed it, not that the
// outcome happened. Each line's evidence is checked against the chain where a
// check exists (server/evidence.ts) and the result stored with it; a line
// shows as verified only once reviewers release it (pnpm review). A
// furnisher's later line can withdraw, replace or dispute an earlier one
// (server/lineState.ts); that takes effect here.
import { readFile } from "node:fs/promises";
import { ENV } from "./_core/env";
import { fetchProof, ingestSignedEvent } from "./counteraudit";
import { COUNTERAUDIT_EXPORT_KEYS } from "./counterauditKeys";
import {
  findOtherOutcomeEventWithEvidence,
  findOutcomeEvent,
  insertOutcomeEvent,
  releaseEvidenceClaim,
  schemaReady,
  updateOutcomeEventEvidence,
  updateOutcomeEventProof,
} from "./db";
import {
  chargeKey,
  verifyEvidence,
  type EvidenceResult,
  type LevyCharge,
} from "./evidence";
import { SCREEN, type FundingScreen } from "./fundingScreen";
import { takesOverClaim, type Line } from "./lineState";
import {
  PROOF_CHECKS,
  isRecord,
  signedEventHash,
  verifyOutcomeProof,
  type CheckResult,
  type ProofVerification,
} from "./outcomeProof";
import { FURNISHERS, registeredSigner, type Furnisher } from "./furnishers";
import { settleDisplayStates } from "./settleLines";
import {
  EVIDENCE_KEY_INDEX,
  OUTCOMES,
  RELATION_TYPES,
} from "../drizzle/schema";

export const TEST_DATA_FLAG = "--test-data";
// Lines of packets furnishers sealed in their own CounterAudit organizations
// (docs/cross-org-intake.md), instead of events for the Bureau to seal.
export const SEALED_FLAG = "--sealed";
// The retention baseline (Phase 0 decision 5): a packet sealed elsewhere must
// show it will be erased within this long of the Bureau receiving it.
export const RETENTION_MONTHS = 24;

export const REFUSAL = [
  `Refused: this intake accepts only runs marked ${TEST_DATA_FLAG}.`,
  "Outcome data from outside waits on the retention decision (Phase 0",
  "decision 5: 24 months, provisional until counsel signs it off) and on",
  "two-person review. Until both exist, the solo-operator path is limited to",
  "test data and internal dry runs.",
].join("\n");

const USAGE = [
  `Usage: pnpm furnish:intake ${TEST_DATA_FLAG} <signed.jsonl>`,
  `       pnpm furnish:intake ${TEST_DATA_FLAG} ${SEALED_FLAG} <sealed.jsonl>`,
].join("\n");

export type IntakeIO = {
  readText(path: string): Promise<string>;
  log(line: string): void;
  now(): Date;
};

const defaultIO: IntakeIO = {
  readText: path => readFile(path, "utf8"),
  log: line => console.log(line),
  now: () => new Date(),
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Outcome = (typeof OUTCOMES)[number];
type RelationType = (typeof RELATION_TYPES)[number];

export type EventFields = {
  furnisherId: string;
  eventId: string;
  keyId: string;
  outcome: Outcome;
  subjectRef: Record<string, unknown>;
  occurredAt: Date;
  relationType: RelationType | null;
  relationTargetEventId: string | null;
};

// Reads the fields the Bureau stores. CounterAudit runs the full furnish v1
// schema and refuses anything else with 422; this only keeps an event the
// Bureau could not store from being sent at all.
export function readEventFields(event: Record<string, unknown>): EventFields | string {
  const { furnisher_id, event_id, key_id, outcome, subject_ref, relation } =
    event;
  if (event.schema_version !== "1") return 'schema_version is not "1"';
  if (
    typeof furnisher_id !== "string" ||
    typeof event_id !== "string" ||
    typeof key_id !== "string"
  ) {
    return "furnisher_id, event_id and key_id must be strings";
  }
  if (!OUTCOMES.includes(outcome as Outcome)) {
    return "outcome is not a v1 outcome";
  }
  if (!isRecord(subject_ref)) return "subject_ref is not an object";
  const occurredAt =
    typeof event.occurred_at === "string" ? new Date(event.occurred_at) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    return "occurred_at is not a date";
  }
  if (typeof event.signature !== "string") return "the event is not signed";
  let relationType: RelationType | null = null;
  let relationTargetEventId: string | null = null;
  if (relation !== undefined) {
    if (
      !isRecord(relation) ||
      !RELATION_TYPES.includes(relation.type as RelationType) ||
      typeof relation.target_event_id !== "string"
    ) {
      return "relation needs a v1 type and a target_event_id";
    }
    relationType = relation.type as RelationType;
    relationTargetEventId = relation.target_event_id;
  }
  return {
    furnisherId: furnisher_id,
    eventId: event_id,
    keyId: key_id,
    outcome: outcome as Outcome,
    subjectRef: subject_ref,
    occurredAt,
    relationType,
    relationTargetEventId,
  };
}

type ProofOutcome =
  | { ran: true; verification: ProofVerification; proof: Record<string, unknown> }
  | { ran: false; reason: string };

// The ingest response is not signed and the proof is. Once the proof verifies, its packet
// fields are the ones stored, and a response that disagrees with them fails the line.
function ingestDisagreements(
  packet: { entry_hash: string; sequence: number | null; created_at: string },
  proof: Record<string, unknown>
): string[] {
  const differs: string[] = [];
  if (proof.entry_hash !== packet.entry_hash) differs.push("entry_hash");
  if ((proof.sequence ?? null) !== packet.sequence) differs.push("sequence");
  if (proof.created_at !== packet.created_at) differs.push("created_at");
  return differs;
}

async function checkProof(
  event: Record<string, unknown>,
  packetId: string,
  orgId: string
): Promise<ProofOutcome> {
  const fetched = await fetchProof(packetId);
  if (!fetched.ok) {
    return {
      ran: false,
      reason: `proof not fetched (${fetched.status ?? "no answer"}: ${fetched.message})`,
    };
  }
  return {
    ran: true,
    verification: verifyOutcomeProof({
      proof: fetched.proof,
      event,
      jwks: COUNTERAUDIT_EXPORT_KEYS,
      orgId,
      packetId,
    }),
    proof: fetched.proof,
  };
}

// The settlement log a line claims, if it may claim one: its proof passed, so
// the furnisher named in it signed it, and the charge's merchant is that
// furnisher's vetted account. Every Levy charge is public, so a line that
// cannot claim a charge must not be able to block the line that can.
function claimedCharge(
  evidence: EvidenceResult,
  proofOk: boolean
): string | null {
  return proofOk && evidence.charge && evidence.recipient_confirmed
    ? chargeKey(evidence.charge)
    : null;
}

// What the chain cannot show: whether another stored line already claims the
// same settlement log. One charge backs one line: a second line's evidence
// fails, which no review can waive (review M-02, 2026-10-31), and it claims
// nothing. The one exception is a line that corrects or supersedes the
// holder, which takes the claim over.
async function settlementHolder(
  claim: string,
  fields: EventFields
): Promise<string | null> {
  const other = await findOtherOutcomeEventWithEvidence(
    claim,
    fields.furnisherId,
    fields.eventId
  );
  return other ? `${other.furnisherId}/${other.eventId}` : null;
}

// The new line as lineState sees it, before it is stored.
function asLine(fields: EventFields, proofOk: boolean): Line {
  return {
    id: 0,
    furnisherId: fields.furnisherId,
    eventId: fields.eventId,
    subjectRef: fields.subjectRef,
    dataClass: "test",
    proofOk,
    evidenceStatus: null,
    evidenceResult: null,
    evidenceKey: null,
    signedEventHash: "",
    displayState: "unverified",
    relationType: fields.relationType,
    relationTargetEventId: fields.relationTargetEventId,
  };
}

function reusedCharge(
  evidence: EvidenceResult,
  holder: string | null
): EvidenceResult {
  return {
    ...evidence,
    status: "failed",
    reasons: [
      ...evidence.reasons,
      `the same charge already backs ${holder ?? "a line stored at the same time"}`,
    ],
  };
}

// True when a write failed because another line already holds the same
// evidenceKey. Drizzle wraps the driver's error, so the causes are searched.
function isEvidenceKeyConflict(error: unknown): boolean {
  for (let e = error, depth = 0; e && typeof e === "object" && depth < 5; depth++) {
    const { code, sqlMessage, cause } = e as {
      code?: unknown;
      sqlMessage?: unknown;
      cause?: unknown;
    };
    if (code === "ER_DUP_ENTRY") {
      // Matched at the end: the message also quotes the duplicated value.
      return new RegExp(`for key '(?:[^']*\\.)?${EVIDENCE_KEY_INDEX}'$`).test(
        String(sqlMessage ?? "")
      );
    }
    e = cause;
  }
  return false;
}

// A claim, once stored, is never cleared by a later check, so a later check
// cannot free the charge for another line.
function evidenceColumns(
  evidence: EvidenceResult,
  claim: string | null,
  checkedAt: Date
) {
  return {
    evidenceStatus: evidence.status,
    evidenceResult: evidence,
    evidenceCheckedAt: checkedAt,
    ...(claim ? { evidenceKey: claim } : {}),
  };
}

function describeEvidence(result: EvidenceResult): string {
  const screen = result.funding_screen
    ? `; funding screen ${result.funding_screen.result}${
        [...result.funding_screen.flags, ...result.funding_screen.gaps].length
          ? `: ${[...result.funding_screen.flags, ...result.funding_screen.gaps].join("; ")}`
          : ""
      }`
    : "";
  return describeVerdict(result) + screen;
}

function describeVerdict({ status, reasons, charge }: EvidenceResult): string {
  if (status === "verified") {
    return charge
      ? `evidence verified (${charge.chain} tx ${charge.tx_hash}, log ${charge.log_index})`
      : "evidence verified";
  }
  const label = {
    failed: "evidence FAILED",
    needs_review: "evidence needs review",
    pending: "evidence not final yet",
    error: "evidence not checked",
  }[status];
  return `${label}: ${reasons.join("; ")}`;
}

type Tally = {
  notSent: number;
  sealed: number;
  alreadySealed: number;
  refused: number;
  conflicts: number;
  failed: number;
  proofVerified: number;
  proofFailed: number;
  proofNotChecked: number;
  evidenceVerified: number;
  evidenceReview: number;
  evidenceFailed: number;
  evidenceNotChecked: number;
  stored: number;
  alreadyStored: number;
  notStored: number;
};

function newTally(): Tally {
  return {
    notSent: 0,
    sealed: 0,
    alreadySealed: 0,
    refused: 0,
    conflicts: 0,
    failed: 0,
    proofVerified: 0,
    proofFailed: 0,
    proofNotChecked: 0,
    evidenceVerified: 0,
    evidenceReview: 0,
    evidenceFailed: 0,
    evidenceNotChecked: 0,
    stored: 0,
    alreadyStored: 0,
    notStored: 0,
  };
}

/** Adds calendar months in UTC, clamping to the month's last day as CounterAudit does. */
function addMonthsUtc(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

// What a new line from a packet sealed in a furnisher's own organization must
// also show, on top of the proof checks every line runs: that the key CounterAudit
// verified is the one the Bureau lists for the furnisher (the furnisher
// registered it there itself), and that CounterAudit has the packet scheduled
// for erasure within the retention baseline of its seal (so the org has a
// policy of 24 months or less). Both come from the signed proof. A hold the
// furnisher's org places on the packet can still keep it longer, and the proof
// does not show holds. These decide only whether a new line is stored.
function sealedChecks(
  proof: Record<string, unknown>,
  publicKey: string,
  receivedAt: Date
): Record<"registered_key" | "retention", CheckResult> {
  const claim = isRecord(proof.outcome_claim) ? proof.outcome_claim : {};
  const signer = isRecord(claim.signer) ? claim.signer : {};
  const expires =
    typeof proof.expires_at === "string" ? new Date(proof.expires_at) : null;
  const sealedAt =
    typeof proof.created_at === "string" ? new Date(proof.created_at) : null;
  let retention: CheckResult;
  if (!expires || Number.isNaN(expires.getTime())) {
    retention = {
      ok: false,
      detail: "the proof shows no expires_at: the packet was not sealed under a retention policy",
    };
  } else if (!sealedAt || Number.isNaN(sealedAt.getTime())) {
    retention = { ok: false, detail: "the proof shows no created_at" };
  } else if (expires.getTime() <= receivedAt.getTime()) {
    retention = { ok: false, detail: `the packet expired at ${proof.expires_at}` };
  } else if (expires.getTime() > addMonthsUtc(sealedAt, RETENTION_MONTHS).getTime()) {
    retention = {
      ok: false,
      detail: `expires_at ${proof.expires_at} is later than ${RETENTION_MONTHS} months after CounterAudit sealed it (${addMonthsUtc(sealedAt, RETENTION_MONTHS).toISOString()})`,
    };
  } else {
    retention = { ok: true };
  }
  return {
    registered_key:
      signer.public_key === publicKey
        ? { ok: true }
        : { ok: false, detail: "the proof's signer key is not the key the Bureau lists for this furnisher" },
    retention,
  };
}

const PACKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One line of a sealed file: `{"packet_id": ..., "event": {...}}`, a packet the
// furnisher sealed in its own CounterAudit organization and the signed event in
// it. Nothing is sent to CounterAudit; the proof is fetched without a key.
async function intakeSealedLine(
  text: string,
  receivedAt: Date,
  io: IntakeIO,
  tally: Tally,
  furnishers: Record<string, Furnisher>
): Promise<{ report: string; clean: boolean }> {
  let line: unknown;
  try {
    line = JSON.parse(text);
  } catch {
    tally.notSent++;
    return { report: "not read: not valid JSON", clean: false };
  }
  if (!isRecord(line) || !isRecord(line.event) || typeof line.packet_id !== "string") {
    tally.notSent++;
    return { report: 'not read: a sealed line is {"packet_id": ..., "event": {...}}', clean: false };
  }
  const packetId = line.packet_id.toLowerCase();
  if (!PACKET_ID.test(packetId)) {
    tally.notSent++;
    return { report: "not read: packet_id is not a CounterAudit packet id", clean: false };
  }
  const event = line.event;
  const fields = readEventFields(event);
  if (typeof fields === "string") {
    tally.notSent++;
    return { report: `not read: ${fields}`, clean: false };
  }
  const ref = `${fields.furnisherId}/${fields.eventId}`;
  const signer = registeredSigner(furnishers, fields.furnisherId, fields.keyId);
  if (!signer.ok) {
    tally.refused++;
    return { report: `${ref}: refused: ${signer.reason}. Not stored.`, clean: false };
  }
  // The two intakes keep apart: the Bureau's own organization is the normal one's.
  if (ENV.counterauditOrgId && signer.counterauditOrgId === ENV.counterauditOrgId) {
    tally.refused++;
    return {
      report: `${ref}: refused: ${fields.furnisherId} is listed under the Bureau's own CounterAudit organization, whose packets the normal intake takes. Not stored.`,
      clean: false,
    };
  }

  const parts = [`packet ${packetId} (furnisher's listed organization ${signer.counterauditOrgId})`];
  // The proof must name the furnisher's own organization: the org check in
  // verifyOutcomeProof pins it.
  const proof = await checkProof(event, packetId, signer.counterauditOrgId);
  const checkedAt = io.now();
  let proofOk = false;
  let orgMatches = false;
  let proofColumns: RecordContext["proofColumns"] = null;
  // On a line the Bureau already holds, only CounterAudit's own checks are
  // recorded: whether the furnisher is still listed, or the packet is past its
  // expiry by now, says nothing about what was sealed, and must not undo a line
  // (a withdrawal stops acting once its proof fails).
  let existingProofColumns: RecordContext["proofColumns"] = null;
  if (!proof.ran) {
    tally.proofNotChecked++;
    parts.push(`proof not checked: ${proof.reason}`);
  } else {
    const extra = sealedChecks(proof.proof, signer.publicKey, receivedAt);
    const checks: Record<string, CheckResult> = { ...proof.verification.checks, ...extra };
    proofOk = Object.values(checks).every(c => c.ok);
    orgMatches = proof.verification.checks.org_id.ok;
    proofColumns = { proofOk, proofChecks: checks, proofCheckedAt: checkedAt };
    existingProofColumns = {
      proofOk: proof.verification.ok,
      proofChecks: proof.verification.checks,
      proofCheckedAt: checkedAt,
    };
    if (proofOk) {
      tally.proofVerified++;
      parts.push("proof verified");
    } else {
      tally.proofFailed++;
      const failed = Object.entries(checks)
        .filter(([, c]) => !c.ok)
        .map(([name, c]) => (c.detail && !(PROOF_CHECKS as readonly string[]).includes(name) ? `${name}: ${c.detail}` : name));
      parts.push(`proof FAILED (${failed.join(", ")})`);
    }
  }
  if (!proofOk) {
    // Nothing new is stored, and a line already held is left alone when the
    // proof names another organization: it was stored from that one.
    const existing = await findOutcomeEvent(fields.furnisherId, fields.eventId);
    if (!existing) {
      tally.notStored++;
      parts.push(
        "not stored: a packet sealed outside the Bureau's organization is stored only once its proof verifies"
      );
      return { report: `${ref}: ${parts.join(", ")}`, clean: false };
    }
    if (proof.ran && !orgMatches) {
      tally.notStored++;
      parts.push(
        "not updated: the Bureau holds this line from another organization than the one the proof names"
      );
      return { report: `${ref}: ${parts.join(", ")}`, clean: false };
    }
  }
  const signed = proof.ran ? proof.proof : {};
  const sealedFields = {
    entryHash: String(signed.entry_hash ?? ""),
    sequence: typeof signed.sequence === "number" ? signed.sequence : null,
    caCreatedAt: new Date(String(signed.created_at ?? receivedAt.toISOString())),
  };
  return recordLine({
    event,
    fields,
    ref,
    parts,
    packetId,
    // CounterAudit's signed proof, kept as the line's record of what was
    // sealed: it checks offline against the export key after the packet is gone.
    receipt: proofOk && proof.ran ? proof.proof : null,
    sealedFields,
    receivedAt,
    proofColumns,
    existingProofColumns,
    proofOk,
    allowInsert: proofOk,
    retryHint: "",
    io,
    tally,
  });
}

// One line of the file. Returns the report line and whether it went through
// cleanly (sealed, proof verified, stored).
async function intakeLine(
  text: string,
  receivedAt: Date,
  io: IntakeIO,
  tally: Tally
): Promise<{ report: string; clean: boolean }> {
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    tally.notSent++;
    return { report: "not sent: not valid JSON", clean: false };
  }
  if (!isRecord(event)) {
    tally.notSent++;
    return { report: "not sent: not a JSON object", clean: false };
  }
  const fields = readEventFields(event);
  if (typeof fields === "string") {
    tally.notSent++;
    return { report: `not sent: ${fields}`, clean: false };
  }
  const ref = `${fields.furnisherId}/${fields.eventId}`;

  const ingest = await ingestSignedEvent(event);
  switch (ingest.kind) {
    case "conflict":
      tally.conflicts++;
      return {
        report: `${ref}: conflict (409 ${ingest.error}): ${ingest.message}. Not stored.`,
        clean: false,
      };
    case "refused":
      tally.refused++;
      return {
        report: `${ref}: refused (422 ${ingest.error}): ${ingest.message}. Not stored.`,
        clean: false,
      };
    case "failed":
      tally.failed++;
      return {
        report: `${ref}: CounterAudit did not seal it (${ingest.status ?? "no answer"} ${ingest.error}${ingest.message ? `: ${ingest.message}` : ""}). Not stored.`,
        clean: false,
      };
  }

  const { packet } = ingest;
  const parts: string[] = [];
  if (ingest.kind === "sealed") {
    tally.sealed++;
    parts.push(`sealed (201) as packet ${packet.packet_id}`);
  } else {
    tally.alreadySealed++;
    parts.push(`already sealed (200) as packet ${packet.packet_id}`);
  }

  const proof = await checkProof(
    event,
    packet.packet_id,
    ENV.counterauditOrgId
  );
  const checkedAt = io.now();
  const signedProof = proof.ran && proof.verification.ok ? proof.proof : null;
  const disagreements = signedProof ? ingestDisagreements(packet, signedProof) : [];
  const proofOk = signedProof !== null && disagreements.length === 0;
  if (!proof.ran) {
    tally.proofNotChecked++;
    parts.push(`proof not checked: ${proof.reason}`);
  } else if (proofOk) {
    tally.proofVerified++;
    parts.push("proof verified");
  } else {
    tally.proofFailed++;
    const failedChecks = [
      ...PROOF_CHECKS.filter(name => !proof.verification.checks[name].ok),
      ...disagreements.map(field => `ingest response ${field} differs from the proof`),
    ];
    parts.push(`proof FAILED (${failedChecks.join(", ")})`);
  }
  const proofColumns = proof.ran
    ? {
        proofOk,
        proofChecks: proof.verification.checks,
        proofCheckedAt: checkedAt,
      }
    : null;
  const sealedFields = signedProof
    ? {
        entryHash: String(signedProof.entry_hash),
        sequence: typeof signedProof.sequence === "number" ? signedProof.sequence : null,
        caCreatedAt: new Date(String(signedProof.created_at)),
      }
    : {
        entryHash: packet.entry_hash,
        sequence: packet.sequence,
        caCreatedAt: new Date(packet.created_at),
      };

  return recordLine({
    event,
    fields,
    ref,
    parts,
    packetId: packet.packet_id,
    receipt: packet.receipt,
    sealedFields,
    receivedAt,
    proofColumns,
    proofOk,
    allowInsert: true,
    io,
    tally,
  });
}

type RecordContext = {
  event: Record<string, unknown>;
  fields: EventFields;
  ref: string;
  parts: string[];
  packetId: string;
  receipt: Record<string, unknown> | null;
  sealedFields: { entryHash: string; sequence: number | null; caCreatedAt: Date };
  receivedAt: Date;
  proofColumns: {
    proofOk: boolean;
    proofChecks: Record<string, CheckResult>;
    proofCheckedAt: Date;
  } | null;
  /** What a line already held records; proofColumns when not given. */
  existingProofColumns?: RecordContext["proofColumns"];
  proofOk: boolean;
  /** False for a sealed line whose proof did not verify: an existing line is updated, none is created. */
  allowInsert: boolean;
  /** Added to "run again to store it" after a failed write. */
  retryHint?: string;
  io: IntakeIO;
  tally: Tally;
};

// The half of a line both intakes share once its packet and proof are known:
// the evidence check, storing or updating the line, and settling its state.
async function recordLine({
  event,
  fields,
  ref,
  parts,
  packetId,
  receipt,
  sealedFields,
  receivedAt,
  proofColumns,
  existingProofColumns = proofColumns,
  proofOk,
  allowInsert,
  retryHint = ", CounterAudit will answer 200 with the same packet",
  io,
  tally,
}: RecordContext): Promise<{ report: string; clean: boolean }> {
  const checked = await verifyEvidence(event);
  const evidenceCheckedAt = io.now();
  let claim = claimedCharge(checked, proofOk);
  let evidence = checked;

  let stored = false;
  try {
    const existing = await findOutcomeEvent(fields.furnisherId, fields.eventId);
    const holder = claim
      ? await findOtherOutcomeEventWithEvidence(
          claim,
          fields.furnisherId,
          fields.eventId
        )
      : undefined;
    // A correction takes the holder's claim over, but only when it is written
    // (writeEvidence), so a line that is not stored takes nothing.
    let takeoverFrom: typeof holder = undefined;
    let takeover: string | null = null;
    if (holder && claim) {
      const label = `${holder.furnisherId}/${holder.eventId}`;
      if (takesOverClaim(asLine(fields, proofOk), holder)) {
        takeoverFrom = holder;
      } else {
        evidence = reusedCharge(checked, label);
        claim = null;
      }
    }
    // Writes the evidence, and if the unique key shows another run claimed the
    // same charge in the meantime, writes it again as that run's second line.
    const writeEvidence = async (
      write: (columns: ReturnType<typeof evidenceColumns>) => Promise<void>
    ) => {
      try {
        if (takeoverFrom && claim) {
          await releaseEvidenceClaim(takeoverFrom.id, claim);
          takeover = `takes over the charge from ${takeoverFrom.furnisherId}/${takeoverFrom.eventId}, which it ${fields.relationType}`;
        }
        await write(evidenceColumns(evidence, claim, evidenceCheckedAt));
      } catch (error) {
        if (!claim || !isEvidenceKeyConflict(error)) throw error;
        evidence = reusedCharge(checked, await settlementHolder(claim, fields));
        claim = null;
        await write(evidenceColumns(evidence, claim, evidenceCheckedAt));
      }
    };
    if (!existing && !allowInsert) {
      tally.notStored++;
      parts.push(
        "not stored: a packet sealed outside the Bureau's organization is stored only once its proof verifies"
      );
    } else if (!existing) {
      await writeEvidence(columns => insertOutcomeEvent({
        furnisherId: fields.furnisherId,
        eventId: fields.eventId,
        keyId: fields.keyId,
        outcome: fields.outcome,
        subjectRef: fields.subjectRef,
        occurredAt: fields.occurredAt,
        relationType: fields.relationType,
        relationTargetEventId: fields.relationTargetEventId,
        signedEvent: event,
        signedEventHash: signedEventHash(event),
        packetId: packetId,
        ...sealedFields,
        receivedAt,
        receipt: receipt,
        ...(proofColumns ?? { proofOk: false }),
        ...columns,
        displayState: "unverified",
        dataClass: "test",
      }));
      tally.stored++;
      stored = true;
      parts.push("stored as unverified test data");
      if (takeover) parts.push(takeover);
    } else if (existing.packetId !== packetId) {
      tally.notStored++;
      parts.push(
        `not stored: the Bureau already holds this event as packet ${existing.packetId}`
      );
    } else if (existing.signedEventHash !== signedEventHash(event)) {
      // Same packet id, different event: the ingest response is not signed,
      // so its checks say nothing about the stored line.
      tally.notStored++;
      parts.push(
        "not updated: the stored line holds a different signed event under this packet"
      );
    } else {
      // The same event sent again: the stored line keeps its times, state
      // and data class. Only checks that reached a result are recorded: a
      // proof check that ran, and an evidence check that is neither pending
      // nor an error.
      if (existingProofColumns)
        await updateOutcomeEventProof(existing.id, existingProofColumns);
      const evidenceReached =
        evidence.status !== "pending" && evidence.status !== "error";
      // A screen that could not finish reading, and found nothing, does not
      // replace a complete one for the same charge, so an explorer outage cannot
      // change what reviewers signed for. One that found a flag replaces it.
      const storedResult = isRecord(existing.evidenceResult) ? existing.evidenceResult : null;
      const storedScreen =
        storedResult && isRecord(storedResult.funding_screen) ? storedResult.funding_screen : null;
      if (
        evidence.funding_screen?.read_failed &&
        evidence.funding_screen.flags.length === 0 &&
        storedScreen &&
        storedScreen.screen === SCREEN &&
        !storedScreen.read_failed &&
        isRecord(storedResult?.charge) &&
        evidence.charge &&
        chargeKey(storedResult.charge as LevyCharge) === chargeKey(evidence.charge)
      ) {
        evidence = { ...evidence, funding_screen: storedScreen as unknown as FundingScreen };
      }
      if (evidenceReached)
        await writeEvidence(columns =>
          updateOutcomeEventEvidence(existing.id, columns)
        );
      tally.alreadyStored++;
      stored = true;
      const updated = [
        ...(proofColumns ? ["proof"] : []),
        ...(evidenceReached ? ["evidence"] : []),
      ];
      parts.push(
        updated.length > 0
          ? `already stored; ${updated.join(" and ")} check${updated.length > 1 ? "s" : ""} updated`
          : "already stored; left unchanged"
      );
      if (takeover) parts.push(takeover);
    }
  } catch (error) {
    tally.notStored++;
    parts.push(
      `not stored (${describeError(error)}); run again to store it${retryHint}`
    );
  }

  if (evidence.status === "verified") tally.evidenceVerified++;
  else if (evidence.status === "needs_review") tally.evidenceReview++;
  else if (evidence.status === "failed") tally.evidenceFailed++;
  else tally.evidenceNotChecked++;
  parts.push(describeEvidence(evidence));

  let settled = true;
  if (stored) {
    try {
      parts.push(
        ...(await settleDisplayStates(fields.furnisherId, fields.eventId))
      );
    } catch (error) {
      settled = false;
      parts.push(
        `display state not settled (${describeError(error)}); run again to settle it`
      );
    }
  }

  const clean = stored && proofOk && settled;
  return { report: `${ref}: ${parts.join(", ")}`, clean };
}

/**
 * Runs the intake over one signed JSONL file, as agent-bureau-furnish sign
 * writes it. Returns the exit code: 0 when every line was sealed, its proof
 * verified and the line stored; 1 when any line was not; 2 when the run was
 * refused before anything was sent.
 */
export async function runIntake(
  argv: string[],
  io: IntakeIO = defaultIO,
  furnishers: Record<string, Furnisher> = FURNISHERS
): Promise<number> {
  const args = argv.filter(arg => arg !== "--");
  if (!args.includes(TEST_DATA_FLAG)) {
    io.log(REFUSAL);
    return 2;
  }
  const files = args.filter(arg => !arg.startsWith("--"));
  const sealed = args.includes(SEALED_FLAG);
  const unknown = args.filter(
    arg => arg.startsWith("--") && arg !== TEST_DATA_FLAG && arg !== SEALED_FLAG
  );
  if (unknown.length > 0 || files.length !== 1) {
    io.log(USAGE);
    return 2;
  }

  // Names only: the values are secrets or connection strings. A sealed run
  // sends nothing to CounterAudit, so it needs no key of the Bureau's.
  const missing = (
    sealed
      ? [["DATABASE_URL", ENV.databaseUrl]]
      : [
          ["COUNTERAUDIT_ORG_ID", ENV.counterauditOrgId],
          ["COUNTERAUDIT_INGEST_KEY", ENV.counterauditIngestKey],
          ["DATABASE_URL", ENV.databaseUrl],
        ]
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    io.log(`Not set: ${missing.join(", ")}. See docs/counteraudit-intake.md.`);
    return 2;
  }
  // Checked before anything is sealed, so a run cannot seal events it then
  // has nowhere to store.
  if (!(await schemaReady())) {
    io.log(
      "The database is not reachable or lacks the outcome_events table. Start the server once so it applies migrations (or run pnpm db:migrate), then try again."
    );
    return 2;
  }

  let text: string;
  try {
    text = await io.readText(files[0]);
  } catch (error) {
    io.log(`Cannot read ${files[0]}: ${describeError(error)}`);
    return 2;
  }

  io.log(
    sealed
      ? `Test-data intake of packets sealed in furnishers' own CounterAudit organizations, proofs from ${ENV.counterauditApiUrl}`
      : `Test-data intake into CounterAudit org ${ENV.counterauditOrgId} at ${ENV.counterauditApiUrl}`
  );
  const tally = newTally();
  let lines = 0;
  let allClean = true;
  const fileLines = text.split(/\r?\n/);
  for (let index = 0; index < fileLines.length; index++) {
    const line = fileLines[index].trim();
    if (line === "") continue;
    lines++;
    const { report, clean } = sealed
      ? await intakeSealedLine(line, io.now(), io, tally, furnishers)
      : await intakeLine(line, io.now(), io, tally);
    if (!clean) allClean = false;
    io.log(`line ${index + 1}: ${report}`);
  }
  if (lines === 0) {
    io.log("No events in the file.");
    return 1;
  }

  const t = tally;
  io.log(
    [
      `Summary: ${lines} line${lines === 1 ? "" : "s"}.`,
      `CounterAudit: ${t.sealed} sealed, ${t.alreadySealed} already sealed, ${t.refused} refused, ${t.conflicts} conflicts, ${t.failed} failed, ${t.notSent} not sent.`,
      `Proofs: ${t.proofVerified} verified, ${t.proofFailed} failed, ${t.proofNotChecked} not checked.`,
      `Evidence: ${t.evidenceVerified} verified, ${t.evidenceReview} to review, ${t.evidenceFailed} failed, ${t.evidenceNotChecked} not checked yet.`,
      `Bureau: ${t.stored} stored, ${t.alreadyStored} already stored, ${t.notStored} not stored.`,
    ].join("\n")
  );
  return allClean ? 0 : 1;
}
