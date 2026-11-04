// An agent's file (docs/agent-file.md): the lines the Bureau holds on one
// subject that reviewers released, as of one time, signed with a Bureau key
// pinned in server/bureauFileKeys.ts. What a line says is read from the signed
// event the reviewers approved, never from the table's copies of its fields.
// Each line points at the CounterAudit packet that sealed it, whose public
// proof anyone can fetch and check against the line with `pnpm file verify`.
import { readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, randomUUID, sign, verify } from "node:crypto";
import canonicalize from "canonicalize";
import { ENV } from "./_core/env";
import { BUREAU_FILE_KEYS } from "./bureauFileKeys";
import { fetchProof } from "./counteraudit";
import { COUNTERAUDIT_EXPORT_KEYS } from "./counterauditKeys";
import { listFileLines, schemaReady } from "./db";
import {
  checkDisputeForm,
  checkLineDisputes,
  checkStoredRecord,
  currentDispute,
  deriveDisputes,
  disputeOf,
  readController,
  signedByWallet,
  type CheckedDisputeRecord,
  type Dispute,
  type DisputeState,
  type StoredDisputeRecord,
} from "./dispute";
import { readEventFields } from "./furnishIntake";
import { proofAdmissionGate, type AdmissionGate } from "./furnisherAdmission";
import { FURNISHERS, type Furnisher } from "./furnishers";
import {
  displayStateFor,
  lineStates,
  relationProblem,
  releaseFor,
  subjectKey,
  type DisplayState,
  type Line,
  type Release,
  type Review,
} from "./lineState";
import {
  decodeCanonicalBase64url,
  isRecord,
  parsePublicKey,
  signedEventHash,
  verifyLineProof,
  verifyLineTombstone,
  type CheckResult,
  type Jwks,
} from "./outcomeProof";
import { evidenceLabel, PAYMENT_OUTCOMES } from "./review";
import { evidenceDigest, newReviewerKey, reviewerPublicKey } from "./reviewDecision";
import { readBureauOrganization, sealFor, type SealedDispute, type SealedEvidence, type SealedLine } from "./evidenceSeal";
import { erasedByRetention, storeSealedDisputes } from "./disputeSync";
import type { ReviewLog } from "./reviewLog";
import { parseHead, readReviewPacket, type Fetch } from "./reviewLogSync";
import { assembleSubjectView } from "./subjectView";
import {
  admissionFor,
  loadCurrentReviewLog,
  readReviewLogNow,
  reviewsFor,
  type ReviewLogPosition,
} from "./settleLines";
import {
  checkSigvaraStanding,
  readSigvaraStanding,
  rpcSigvaraClient,
  type SigvaraClient,
  type SigvaraStanding,
} from "./sigvaraStanding";

export const FILE_SCHEMA = "agent-bureau/file/v1";
// Domain separation: nothing else a file key signs can pass for a file.
const SIGNING_CONTEXT = "agent-bureau/file/v1\n";

/**
 * Files with live lines wait for counsel's review of how the Bureau keeps and uses them (the
 * owner's decision, 2026-11-02), and so does paid access to files, which is not built. Until a
 * pull request that cites that review sets this to false, a file is signed only for a subject
 * whose lines on it are all test data. The review log releasing a live line does not lift it.
 */
export const LIVE_FILES_HELD = true;

// Review finding M-04 (docs/independent-payer.md): every file carries it.
export const PAYMENT_DISCLOSURE =
  "A settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered.";

const FACTS_DISCLOSURE =
  "A file states outcomes that furnishers reported, with dates and sources, after reviewers released them. It is not a score, a grade or a recommendation.";
const SOLO_TEST_DISCLOSURE =
  "A line released solo_test is test data released by one reviewer; live data needs two different reviewers.";
const TEST_DATA_DISCLOSURE =
  "Every line on this file is test data: furnished to test the Bureau, not about real dealings.";
const TESTNET_REVIEWERS_DISCLOSURE =
  "The reviewers who released these lines are testnet keys the Bureau's operator holds, not independent reviewers, so two_person here does not mean two independent people.";
const EXPIRY_DISCLOSURE =
  "A line can be checked against CounterAudit until its counteraudit.checkable_until, when CounterAudit erases its source under its retention policy. After that its proof URL answers with CounterAudit's signed record of the erasure, which still shows where the packet sat in its chain but no longer its outcome, and the line rests on the Bureau's signature alone. Lines whose source is erased are left off new files.";
const HISTORY_DISCLOSURE =
  "history lists released lines the same furnisher later withdrew or replaced. They are kept as a record of what was reported, not as current facts.";
const PROBATION_DISCLOSURE =
  "A line marked furnisher_on_probation was sealed before its furnisher's probation ended. The probation starts when two reviewers admit the furnisher. Such a line is released only on approvals that waive nothing: no reviewer can waive its evidence or a settled payment's funding screen.";
const DISPUTE_DISCLOSURE =
  "A line with a dispute was disputed by its subject, who signed the dispute with the wallet the line names. While a dispute is open the furnisher has until respond_by to confirm the line with evidence, correct it or withdraw it, and a line it does not answer by then is removed from every file. A line the furnisher confirmed stays and may carry the subject's statement. A dispute records that the subject contests the line, not which side is right.";

// What a file cannot show yet, said rather than left out (bureau-spec.md,
// "What a file contains").
export const NOT_ON_FILE = [
  "Subject matching: only lines naming exactly this subject reference are here (an EVM address, in a wallet or a did:sigvara, compares without case). Other spellings, registrations, wallets or DIDs of the same operator are not matched (Phase 3).",
  "Lines reviewers have not released are held and not shown, whatever their outcome.",
  "Public record and payment history are not assembled into files yet. Third-party standing comes only from Sigvara, and only for a did:sigvara agent on Arc testnet.",
  "Inquiries are not built yet. A subject disputes a line by sending a signed record to CounterAudit or to the Bureau's operator (docs/disputes.md); a page where subjects file disputes themselves is not built.",
];

// Subscribers see a furnisher's category, not its name (bureau-spec.md). Listed
// by pull request with the furnisher.
export const FURNISHER_CATEGORIES: Record<string, string> = {
  fur_bureaupilot01: "Bureau pilot test furnisher",
};
const UNLISTED_CATEGORY = "category not listed";

export type FileLine = {
  outcome: string;
  /** The furnisher's claim, inside its signed event; never independently checked. */
  occurred_at: string;
  received_at: string;
  sealed_at: string;
  data_class: "test" | "live";
  furnisher_category: string;
  display_state: Exclude<DisplayState, "unverified" | "removed">;
  /** The subject's dispute on the line (docs/disputes.md). Absent when there is none. */
  dispute?: FileDispute;
  released: Release;
  /**
   * Live data sealed before its furnisher's probation ended (server/furnisherAdmission.ts).
   * Absent otherwise, and on a file assembled before admissions were recorded.
   */
  furnisher_on_probation?: true;
  /**
   * The review-log decisions on this line, by their packets in the review organization, so a
   * reader with access to it can see which decisions the release was taken from. Absent on a
   * file assembled before these were recorded.
   */
  review_decisions?: {
    sequence: number;
    packet_id: string;
    decision: string;
  }[];
  /** What the evidence check proved, by the M-04 names, or that reviewers waived it. */
  evidence: string;
  /**
   * The evidence result the line was released on, as CounterAudit sealed it last for the line in
   * the Bureau's organization (server/evidenceSeal.ts): the packet, its place in that
   * organization's chain, and the digest reviewers' approvals name. pnpm file verify --current
   * checks it is still the last one. Absent on a file assembled before evidence was sealed.
   */
  evidence_seal?: {
    org_id: string;
    packet_id: string;
    sequence: number;
    evidence_digest: string;
  };
  payment?: {
    subject_control: "unproven";
    payer_independence_screen: "clear" | "flagged" | "inconclusive";
  };
  counteraudit: {
    packet_id: string;
    org_id: string;
    sequence: number | null;
    entry_hash: string;
    signed_event_hash: string;
    proof_url: string;
    /**
     * When CounterAudit erases the packet under its retention policy, as its proof said just
     * before the file was assembled, or null when it set no date. The line can be checked
     * against the proof until then. Absent on a file assembled before this was recorded.
     */
    checkable_until?: string | null;
  };
};

export type FileDispute = {
  state: Exclude<DisputeState, "lapsed">;
  /** When CounterAudit sealed the subject's dispute. */
  filed_at: string;
  /** The furnisher's deadline, while the dispute is open. */
  respond_by?: string;
  /** When CounterAudit sealed the furnisher's confirmation. */
  confirmed_at?: string;
  /** The subject's statement beside a confirmed line. */
  statement?: string;
};

function fileDispute(dispute: Dispute): FileDispute {
  return {
    state: dispute.state as FileDispute["state"],
    filed_at: dispute.filedAt.toISOString(),
    ...(dispute.state === "open"
      ? { respond_by: dispute.respondBy.toISOString() }
      : {}),
    ...(dispute.confirmedAt
      ? { confirmed_at: dispute.confirmedAt.toISOString() }
      : {}),
    ...(dispute.statement !== null ? { statement: dispute.statement } : {}),
  };
}

export type AgentFile = {
  schema: typeof FILE_SCHEMA;
  file_id: string;
  issued_at: string;
  subject: { subject_ref: Record<string, unknown>; matching: "exact" };
  reviewers: "independent" | "operator_held_testnet";
  /**
   * The newest review-log packet the Bureau had read from CounterAudit just before assembling,
   * or null for an empty log. Every release on the file was decided against the log up to it.
   * Absent on a file assembled before this was recorded.
   */
  review_log?: {
    org_id: string;
    sequence: number;
    entry_hash: string;
    packet_id: string;
  } | null;
  /** Released lines that stand: released, or disputed and shown with the dispute. */
  furnished_outcomes: FileLine[];
  /** Released lines the furnisher later withdrew or replaced. */
  history: FileLine[];
  /** Third-party facts about the agent, each with its source and when it was read. */
  third_party_standing: SigvaraStanding[];
  disclosures: string[];
  not_on_file: string[];
};

export type SignedAgentFile = AgentFile & {
  signature: { algorithm: "ed25519"; key_id: string; value: string };
};

/** A stored line, as listFileLines reads it. */
export type StoredLine = Line & {
  outcome: string;
  occurredAt: Date | string;
  receivedAt: Date | string;
  caCreatedAt: Date | string;
  packetId: string;
  entryHash: string;
  sequence: number | null;
  signedEvent: unknown;
  /** When the Bureau erased the row's content, its source having expired (server/lineExpiry.ts). */
  expiredAt?: Date | string | null;
};

// ---- What a file is about ----

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DID = /^did:[a-z0-9]+:\S+$/;
const CHAINS = ["arc", "base", "bnb", "robinhood", "solana"];

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every(k => Object.hasOwn(value, k));

/** A subject_ref in one of the outcome event v1 forms, or why it is not. */
export function readSubjectRef(
  value: unknown
): Record<string, unknown> | string {
  const hint =
    'a subject_ref as outcome event v1 has it: {"wallet":"0x..."}, {"did":"did:..."} or {"chain":"arc","registry":"...","id":"..."}';
  if (!isRecord(value)) return `not ${hint}`;
  const str = (k: string, max: number) =>
    typeof value[k] === "string" &&
    (value[k] as string).length >= 1 &&
    (value[k] as string).length <= max;
  if (exactKeys(value, ["wallet"])) {
    const w = value.wallet;
    return typeof w === "string" &&
      (EVM_ADDRESS.test(w) || SOLANA_ADDRESS.test(w))
      ? value
      : "wallet is not an EVM or Solana address";
  }
  if (exactKeys(value, ["did"])) {
    return str("did", 256) && DID.test(value.did as string)
      ? value
      : "did is not a DID";
  }
  if (exactKeys(value, ["chain", "registry", "id"])) {
    return CHAINS.includes(value.chain as string) &&
      str("registry", 64) &&
      str("id", 128)
      ? value
      : "chain, registry or id is not in the v1 form";
  }
  return `not ${hint}`;
}

// ---- Lines from their signed events ----

// A MariaDB server older than 10.5.2 returns JSON columns as text.
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

/**
 * The line as its signed event says it, or why it cannot be read so. The event
 * must hash to the signedEventHash reviewers signed, and name the row's own
 * furnisher and event id; its subject, outcome, time and relation then replace
 * the table's copies, which nothing signs.
 */
export function fromSignedEvent(row: StoredLine): StoredLine | string {
  const label = `${row.furnisherId}/${row.eventId}`;
  const event = asRecord(row.signedEvent);
  if (!event) return `${label}: no signed event stored`;
  let hash: string;
  try {
    hash = signedEventHash(event);
  } catch {
    return `${label}: the signed event has no canonical form`;
  }
  if (hash !== row.signedEventHash) {
    return `${label}: the signed event does not hash to the line's signed_event_hash`;
  }
  const fields = readEventFields(event);
  if (typeof fields === "string") return `${label}: ${fields}`;
  if (
    fields.furnisherId !== row.furnisherId ||
    fields.eventId !== row.eventId
  ) {
    return `${label}: the signed event names another furnisher or event`;
  }
  return {
    ...row,
    outcome: fields.outcome,
    subjectRef: fields.subjectRef,
    occurredAt: fields.occurredAt,
    relationType: fields.relationType,
    relationTargetEventId: fields.relationTargetEventId,
  };
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// A cap hit, an incomplete history or no screen at all is inconclusive, never
// clear (docs/independent-payer.md).
function screenOf(line: StoredLine): "clear" | "flagged" | "inconclusive" {
  const screen = asRecord(line.evidenceResult)?.funding_screen;
  const result = isRecord(screen) ? screen.result : null;
  return result === "clear" || result === "flagged" ? result : "inconclusive";
}

export type AssembleOptions = {
  now: Date;
  /** The Bureau's own CounterAudit organization, where unlisted furnishers' lines are sealed. */
  bureauOrgId: string;
  testnetReviewers: boolean;
  fileId?: string;
  proofBase?: string;
  furnishers?: Record<string, Furnisher>;
  /** Sigvara's standing for the subject, read by the caller, or null when there is none. */
  standing?: SigvaraStanding | null;
  /** The review organization and how far its log was read, for the file to state. */
  reviewLog?: { orgId: string; position: ReviewLogPosition | null };
  /**
   * Whether a line's furnisher is admitted (admissionFor in server/settleLines.ts). Without it
   * no live line is released.
   */
  admissionOf?: (line: Line) => AdmissionGate;
  /**
   * Each line's source, by packet id, as CounterAudit's proof stated it just before assembling
   * (readSources). A line whose source is erased or past its retention date is left off and
   * listed in `expired`; one with no entry is skipped. Without this the file states no
   * checkable_until.
   */
  sources?: Record<string, LineSource>;
  /**
   * For each line relating to another (a dispute, withdrawal, replacement or correction), by
   * packet id, whether CounterAudit's proof of it checks now (readSources). With this a relating
   * line acts only when its proof checks, whatever its stored proofOk says. Without it the stored
   * proofOk counts.
   */
  relatingProofs?: Record<string, boolean>;
  /**
   * The evidence result CounterAudit sealed last for each line, by signed_event_hash
   * (readEvidenceSeals). With this an approval counts only while the line's stored result is that
   * one, a line its stored data would release otherwise is listed in `skipped`, and each line names
   * its seal. Without it the stored result counts.
   */
  evidenceSeals?: Map<string, SealedEvidence>;
};

/** What CounterAudit says of a line's source: until when it can be checked, or why it cannot. */
export type LineSource =
  { checkableUntil: string | null } | { expired: string };

/**
 * The file for one subject: its lines that reviewers released, newest first,
 * with what the Bureau knows of each. Pure: the caller reads the lines, the
 * review log and the lines' sources, and checks each line's dispute records again
 * (checkLineDisputes). Lines are read from their signed events;
 * one that cannot be is left off, and listed in `skipped` for the operator, not
 * on the file. A line whose source CounterAudit has erased is left off too, and
 * listed in `expired`.
 */
export function assembleFile(
  subjectRef: Record<string, unknown>,
  rows: StoredLine[],
  storedReviewsOf: (line: Line) => Review[],
  options: AssembleOptions
): {
  file: AgentFile;
  skipped: string[];
  expired: string[];
  sourcesFor: StoredLine[];
  relating: StoredLine[];
} {
  const furnishers = options.furnishers ?? FURNISHERS;
  const proofBase = (options.proofBase ?? ENV.counterauditApiUrl).replace(
    /\/+$/,
    ""
  );
  const skipped: string[] = [];
  const expired: string[] = [];
  // The seal that counts for a line, when its stored result is the one CounterAudit sealed last.
  const sealOf = (line: Line) => {
    const seal = options.evidenceSeals && sealFor(options.evidenceSeals, line);
    return seal && seal.record.evidence_digest === evidenceDigest(line.evidenceResult)
      ? seal
      : undefined;
  };
  // With seals, an approval counts only while the stored result is the one sealed last, so a
  // result put back from before counts for nothing. A rejection holds the line whatever it was
  // signed against.
  const reviewsOf = (line: Line): Review[] => {
    const reviews = storedReviewsOf(line);
    return !options.evidenceSeals || sealOf(line)
      ? reviews
      : reviews.filter(r => r.decision === "reject");
  };
  const lines: StoredLine[] = [];
  for (const row of rows) {
    // Erased with its source: it says nothing any more, and names no subject.
    if (row.expiredAt) continue;
    const line = fromSignedEvent(row);
    if (typeof line === "string") skipped.push(line);
    else lines.push(line);
  }
  const key = subjectKey(subjectRef);
  // The same furnisher's lines whose relation points at a line, matched exactly
  // as findRelatingOutcomeLines does, from their signed events.
  const relatingRows = (target: StoredLine) =>
    lines.filter(
      r =>
        r.furnisherId === target.furnisherId &&
        r.relationTargetEventId === target.eventId
    );
  // Nothing signs a relating line's proofOk or display state, so neither decides what it does
  // on a file: with relatingProofs its proof is the one CounterAudit answers now, and a dispute
  // counts as withdrawn only when a withdrawal among these lines acts on it.
  const checked = (r: StoredLine): StoredLine =>
    options.relatingProofs
      ? {
          ...r,
          proofOk:
            Object.hasOwn(options.relatingProofs, r.packetId) &&
            options.relatingProofs[r.packetId] === true,
        }
      : r;
  const relatingTo = (target: StoredLine): StoredLine[] =>
    relatingRows(target)
      .map(checked)
      .map(r =>
        r.relationType !== "disputes"
          ? r
          : {
              ...r,
              displayState: relatingRows(r).some(
                w => w.relationType === "withdraws" && relationProblem(checked(w), r) === null
              )
                ? ("withdrawn" as const)
                : ("unverified" as const),
            }
      );
  // What readSources must check for this file: every line reviewers released, even one a
  // lapsed subject dispute removes (an answer that checks can undo the lapse), and each relating
  // line that could act on one, with the withdrawals of its disputes.
  const sourcesFor = new Set<StoredLine>();
  const relatingUsed = new Set<StoredLine>();
  const mayAct = (r: StoredLine, target: StoredLine) =>
    relationProblem({ ...r, proofOk: true }, target) === null;
  const standing: FileLine[] = [];
  const history: FileLine[] = [];
  for (const line of lines) {
    if (!line.subjectRef || subjectKey(line.subjectRef) !== key) continue;
    const relating = relatingTo(line);
    const reviews = reviewsOf(line);
    const admission = options.admissionOf?.(line);
    // Released on what the Bureau stores, but not on the result sealed last: the store was changed,
    // or a run did not seal what it stored, so nothing is signed until that is put right.
    if (
      options.evidenceSeals &&
      !sealOf(line) &&
      releaseFor(line, storedReviewsOf(line), admission).released
    ) {
      skipped.push(
        `${line.packetId}: its stored evidence result is not the one CounterAudit sealed last for it`
      );
    }
    if (releaseFor(line, reviews, admission).released) {
      sourcesFor.add(line);
      for (const r of relatingRows(line).filter(r => mayAct(r, line))) {
        relatingUsed.add(r);
        if (r.relationType !== "disputes") continue;
        for (const w of relatingRows(r)) {
          if (w.relationType === "withdraws" && mayAct(w, r)) relatingUsed.add(w);
        }
      }
    }
    // A lapsed subject dispute removes the line from every file, history included.
    const dispute = disputeOf(line, relating, reviewsOf, options.now, options.admissionOf);
    const states = lineStates(line, relating, reviews, dispute?.state ?? null, admission);
    if (!states.released) continue;
    const display = displayStateFor(states);
    if (display === "unverified" || display === "removed") continue;
    const source =
      options.sources && Object.hasOwn(options.sources, line.packetId)
        ? options.sources[line.packetId]
        : undefined;
    if (options.sources && !source) {
      skipped.push(
        `${line.packetId}: its source was not read from CounterAudit`
      );
      continue;
    }
    if (source && "expired" in source) {
      expired.push(`${line.packetId}: ${source.expired}`);
      continue;
    }
    const listed = Object.hasOwn(furnishers, line.furnisherId)
      ? furnishers[line.furnisherId].counterauditOrgId
      : undefined;
    const seal = sealOf(line);
    const entry: FileLine = {
      outcome: line.outcome,
      occurred_at: iso(line.occurredAt),
      received_at: iso(line.receivedAt),
      sealed_at: iso(line.caCreatedAt),
      data_class: line.dataClass,
      furnisher_category: Object.hasOwn(FURNISHER_CATEGORIES, line.furnisherId)
        ? FURNISHER_CATEGORIES[line.furnisherId]
        : UNLISTED_CATEGORY,
      display_state: display,
      ...(dispute ? { dispute: fileDispute(dispute) } : {}),
      released: states.released,
      ...(line.dataClass === "live" && admission?.admitted && admission.onProbation
        ? { furnisher_on_probation: true as const }
        : {}),
      ...(reviews.length > 0 && reviews.every(r => r.packetId)
        ? {
            review_decisions: reviews.map(r => ({
              sequence: r.id,
              packet_id: r.packetId as string,
              decision: r.decision,
            })),
          }
        : {}),
      evidence: states.evidence_verified
        ? evidenceLabel(line.outcome, "verified")
        : "waived_by_reviewers",
      ...(seal
        ? {
            evidence_seal: {
              org_id: options.bureauOrgId,
              packet_id: seal.packetId,
              sequence: seal.sequence,
              evidence_digest: seal.record.evidence_digest,
            },
          }
        : {}),
      ...(PAYMENT_OUTCOMES.has(line.outcome)
        ? {
            payment: {
              subject_control: "unproven" as const,
              payer_independence_screen: screenOf(line),
            },
          }
        : {}),
      counteraudit: {
        packet_id: line.packetId,
        // Where the intake checked the proof: a listed furnisher's own
        // organization, else the Bureau's.
        org_id: listed ?? options.bureauOrgId,
        sequence: line.sequence,
        entry_hash: line.entryHash,
        signed_event_hash: line.signedEventHash,
        proof_url: `${proofBase}/v1/proofs/${encodeURIComponent(line.packetId)}`,
        ...(source ? { checkable_until: source.checkableUntil } : {}),
      },
    };
    (display === "withdrawn" || display === "superseded"
      ? history
      : standing
    ).push(entry);
  }
  const order = (a: FileLine, b: FileLine) =>
    b.occurred_at.localeCompare(a.occurred_at) ||
    a.counteraudit.packet_id.localeCompare(b.counteraudit.packet_id);
  standing.sort(order);
  history.sort(order);
  const all = [...standing, ...history];
  const disclosures = [FACTS_DISCLOSURE, PAYMENT_DISCLOSURE];
  if (history.length > 0) disclosures.push(HISTORY_DISCLOSURE);
  if (all.some(l => l.dispute)) disclosures.push(DISPUTE_DISCLOSURE);
  if (all.some(l => l.furnisher_on_probation)) disclosures.push(PROBATION_DISCLOSURE);
  if (all.some(l => typeof l.counteraudit.checkable_until === "string"))
    disclosures.push(EXPIRY_DISCLOSURE);
  if (all.some(l => l.released === "solo_test"))
    disclosures.push(SOLO_TEST_DISCLOSURE);
  if (options.testnetReviewers) disclosures.push(TESTNET_REVIEWERS_DISCLOSURE);
  if (all.length > 0 && all.every(l => l.data_class === "test"))
    disclosures.push(TEST_DATA_DISCLOSURE);
  return {
    file: {
      schema: FILE_SCHEMA,
      file_id: options.fileId ?? randomUUID(),
      issued_at: options.now.toISOString(),
      subject: { subject_ref: subjectRef, matching: "exact" },
      reviewers: options.testnetReviewers
        ? "operator_held_testnet"
        : "independent",
      ...(options.reviewLog
        ? {
            review_log: options.reviewLog.position
              ? {
                  org_id: options.reviewLog.orgId,
                  sequence: options.reviewLog.position.sequence,
                  entry_hash: options.reviewLog.position.entryHash,
                  packet_id: options.reviewLog.position.packetId,
                }
              : null,
          }
        : {}),
      furnished_outcomes: standing,
      history,
      third_party_standing: options.standing ? [options.standing] : [],
      disclosures,
      not_on_file: NOT_ON_FILE,
    },
    skipped,
    expired,
    sourcesFor: [...sourcesFor],
    relating: [...relatingUsed],
  };
}

// ---- Signing ----

function signingPayload(file: unknown): Buffer {
  const canonical = canonicalize(file);
  if (canonical === undefined)
    throw new Error("the file has no canonical form");
  return Buffer.concat([
    Buffer.from(SIGNING_CONTEXT, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);
}

/** Signs a file with a pinned key; refuses a key that is not the one pinned under keyId. */
export function signFile(
  file: AgentFile,
  privateKeyPem: string,
  keyId: string,
  keys: Record<string, string> = BUREAU_FILE_KEYS
): SignedAgentFile {
  if (!Object.hasOwn(keys, keyId)) {
    throw new Error(`key ${keyId} is not pinned in server/bureauFileKeys.ts`);
  }
  if (reviewerPublicKey(privateKeyPem) !== keys[keyId]) {
    throw new Error(`this private key is not the one pinned as ${keyId}`);
  }
  const value = sign(
    null,
    signingPayload(file),
    createPrivateKey(privateKeyPem)
  ).toString("base64url");
  return { ...file, signature: { algorithm: "ed25519", key_id: keyId, value } };
}

const pass: CheckResult = { ok: true };
const fail = (detail: string): CheckResult => ({ ok: false, detail });

/** The checks that failed, by name and why, for one line of output. */
function failedChecks(checks: Record<string, CheckResult>): string {
  return Object.entries(checks)
    .filter(([, c]) => !c.ok)
    .map(([name, c]) => `${name}${c.detail ? `: ${printable(c.detail)}` : ""}`)
    .join("; ");
}

/** Whether a pinned Bureau key signed this file, unchanged. */
export function checkFileSignature(
  signed: unknown,
  keys: Record<string, string> = BUREAU_FILE_KEYS
): CheckResult {
  try {
    if (!isRecord(signed)) return fail("not a file");
    const { signature, ...file } = signed;
    if (file.schema !== FILE_SCHEMA) return fail(`not an ${FILE_SCHEMA} file`);
    if (!isRecord(signature) || signature.algorithm !== "ed25519") {
      return fail("no ed25519 signature");
    }
    const keyId = signature.key_id;
    if (typeof keyId !== "string" || !Object.hasOwn(keys, keyId)) {
      return fail("signed with a key that is not pinned");
    }
    const bytes =
      typeof signature.value === "string"
        ? decodeCanonicalBase64url(signature.value, 64)
        : null;
    if (!bytes)
      return fail("the signature is not 64 bytes of canonical base64url");
    return verify(
      null,
      signingPayload(file),
      parsePublicKey(keys[keyId]),
      bytes
    )
      ? pass
      : fail(
          `the signature does not verify with ${keyId}: the file was changed or signed with another key`
        );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ---- Reading an untrusted file ----

/**
 * The first object key that appears twice in the same object of this JSON
 * text, or null. JSON.parse keeps the last one silently, so a file with a
 * duplicate could read one way here and another way to a different parser.
 * Call only on text JSON.parse accepted.
 */
export function duplicateKey(text: string): string | null {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      expectKey = stack.at(-1) instanceof Set;
    }
  }
  return null;
}

// Text from an untrusted file, safe to print: no terminal control characters.
function printable(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value) ?? String(value));
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 300);
}

// ---- pnpm file ----

export const USAGE = [
  "Usage:",
  "  pnpm file keygen <private-key-file>",
  "  pnpm file assemble --subject <subject_ref JSON> --key <private-key-file> --key-id <key id> --out <file>",
  "  pnpm file verify <file> [--subject <subject_ref JSON>] [--max-age-days <days>] [--current | --offline]",
  "  pnpm file subject --subject <subject_ref JSON> --out <file>",
].join("\n");

export type FileIO = {
  readText(path: string): Promise<string>;
  // Writes a new file readable only by its owner; fails if it exists.
  writeNewPrivateFile(path: string, text: string): Promise<void>;
  // Writes a new file; fails if it exists.
  writeNewFile(path: string, text: string): Promise<void>;
  log(line: string): void;
  now(): Date;
  fetchProof: typeof fetchProof;
  // CounterAudit, for the review log; the global fetch when not given.
  fetch?: Fetch;
  jwks: Jwks;
  keys: Record<string, string>;
  furnishers: Record<string, Furnisher>;
  sigvara: SigvaraClient;
};

const defaultIO: FileIO = {
  readText: path => readFile(path, "utf8"),
  writeNewPrivateFile: (path, text) =>
    writeFile(path, text, { flag: "wx", mode: 0o600 }),
  writeNewFile: (path, text) => writeFile(path, text, { flag: "wx" }),
  log: line => console.log(line),
  now: () => new Date(),
  fetchProof,
  jwks: COUNTERAUDIT_EXPORT_KEYS,
  keys: BUREAU_FILE_KEYS,
  furnishers: FURNISHERS,
  sigvara: rpcSigvaraClient(ENV.arcTestnetRpcUrl),
};

function describeError(error: unknown): string {
  return printable(error instanceof Error ? error.message : String(error));
}

// --name value pairs; null when the arguments do not parse or a flag repeats.
function readFlags(args: string[]): Record<string, string> | null {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      Object.hasOwn(flags, name.slice(2))
    ) {
      return null;
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

function parseSubjectFlag(text: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  return readSubjectRef(value);
}

async function keygen(args: string[], io: FileIO): Promise<number> {
  if (args.length !== 1) {
    io.log(USAGE);
    return 2;
  }
  const { privateKeyPem, publicKey } = newReviewerKey();
  try {
    await io.writeNewPrivateFile(args[0], privateKeyPem);
  } catch (error) {
    io.log(`Could not write ${args[0]}: ${describeError(error)}`);
    return 1;
  }
  io.log(`Wrote the private key to ${args[0]}, readable only by you.`);
  io.log(`Public key: ${publicKey}`);
  io.log(
    "Pin it in server/bureauFileKeys.ts under a new key id, by pull request, before signing with it."
  );
  return 0;
}

async function assemble(args: string[], io: FileIO): Promise<number> {
  const flags = readFlags(args);
  if (
    !flags ||
    !flags.subject ||
    !flags.key ||
    !flags["key-id"] ||
    !flags.out ||
    Object.keys(flags).length !== 4
  ) {
    io.log(USAGE);
    return 2;
  }
  const subjectRef = parseSubjectFlag(flags.subject);
  if (typeof subjectRef === "string") {
    io.log(`--subject: ${subjectRef}.`);
    return 2;
  }
  let privateKeyPem: string;
  try {
    privateKeyPem = await io.readText(flags.key);
  } catch (error) {
    io.log(`Could not read ${flags.key}: ${describeError(error)}`);
    return 1;
  }
  const missing = [
    ["DATABASE_URL", ENV.databaseUrl],
    ["COUNTERAUDIT_ORG_ID", ENV.counterauditOrgId],
    ["COUNTERAUDIT_READ_KEY", ENV.counterauditReadKey],
    ["COUNTERAUDIT_REVIEW_ORG_ID", ENV.counterauditReviewOrgId],
    ["COUNTERAUDIT_REVIEW_READ_KEY", ENV.counterauditReviewReadKey],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    io.log(
      `Not set: ${missing.map(([name]) => name).join(", ")}. See docs/agent-file.md.`
    );
    return 2;
  }
  if (!(await schemaReady())) {
    io.log("The database is not reachable or lacks the outcome tables.");
    return 1;
  }
  // The whole review log as CounterAudit holds it now, not as the last pnpm review sync left
  // it: a rejection sealed since then must hold its line on this file (review M-01).
  let current: Awaited<ReturnType<typeof loadCurrentReviewLog>>;
  try {
    current = await loadCurrentReviewLog({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReviewReadKey,
      orgId: ENV.counterauditReviewOrgId,
      fetch: io.fetch,
      now: io.now(),
    });
  } catch (error) {
    current = { problem: describeError(error) };
  }
  if ("problem" in current) {
    io.log(
      `Not signed: the review log could not be brought up to date: ${printable(current.problem)}`
    );
    return 1;
  }
  const { log, position } = current;
  // Read before anything is signed: a file that should carry Sigvara's standing
  // and cannot is not signed without it.
  let standing: SigvaraStanding | null;
  try {
    standing = await readSigvaraStanding(subjectRef, io.sigvara);
  } catch (error) {
    io.log(`Not signed: Sigvara could not be read: ${describeError(error)}`);
    return 1;
  }
  // The evidence result sealed last for each line, and every dispute record, as CounterAudit
  // holds them now, read to the organization's attested head.
  let seals: Awaited<ReturnType<typeof readBureauOrganization>>;
  try {
    seals = await readBureauOrganization({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReadKey,
      orgId: ENV.counterauditOrgId,
      fetch: io.fetch,
    });
  } catch (error) {
    seals = { problem: describeError(error) };
  }
  if ("problem" in seals) {
    io.log(`Not signed: the evidence seals could not be read: ${printable(seals.problem)}`);
    return 1;
  }
  // A dispute the subject or furnisher sent to CounterAudit themselves is stored before anything
  // is read from the store, so it counts on this file whether or not anyone synced it (review
  // AB-02).
  try {
    const synced = await storeSealedDisputes(seals, io);
    if (synced.stored > 0) io.log(`Stored ${synced.stored} dispute record${synced.stored === 1 ? "" : "s"} sealed in CounterAudit.`);
    if (synced.problems.length > 0) {
      io.log(`Not signed: the stored dispute records do not match what CounterAudit sealed: ${printable(synced.problems.join("; "))}`);
      return 1;
    }
  } catch (error) {
    io.log(`Not signed: the dispute records sealed in CounterAudit could not be stored: ${describeError(error)}`);
    return 1;
  }
  // Each line's dispute records are checked again from the records themselves.
  const rows: StoredLine[] = [];
  for (const row of (await listFileLines()) as StoredLine[]) {
    rows.push(await checkLineDisputes(row, io.furnishers));
  }
  const reviewsOf = (line: Line) => reviewsFor(line, log);
  const assembleOptions: AssembleOptions = {
    now: io.now(),
    bureauOrgId: ENV.counterauditOrgId,
    testnetReviewers: log.testnet,
    furnishers: io.furnishers,
    admissionOf: line => admissionFor(line, log, io.furnishers),
    standing,
    reviewLog: { orgId: ENV.counterauditReviewOrgId, position },
    evidenceSeals: seals.seals,
  };
  const draft = assembleFile(subjectRef, rows, reviewsOf, assembleOptions);
  // Left off, a live line would make the file say less than the Bureau holds, so the file waits.
  const live = [...draft.file.furnished_outcomes, ...draft.file.history].filter(
    l => l.data_class === "live"
  ).length;
  if (live > 0 && LIVE_FILES_HELD) {
    io.log(
      `Not signed: ${live} of the lines on this file are live data, and files with live lines are held until counsel has reviewed how the Bureau keeps and uses them (LIVE_FILES_HELD in server/agentFile.ts).`
    );
    return 1;
  }
  // A stored line whose signed event does not check, or whose evidence result is not the one
  // sealed last, means the store was changed or damaged; a withdrawal that stops acting that way
  // could put a line back on a file, so nothing is signed until it is fixed.
  if (draft.skipped.length > 0) {
    for (const reason of draft.skipped) io.log(printable(reason));
    io.log(
      "Not signed: these lines do not check against their signed events or sealed evidence. Re-run the intake for them, or find out who changed them."
    );
    return 1;
  }
  // Each line is checkable until its source's retention date, and no longer on a file after.
  const sources = await readSources(
    draft.sourcesFor,
    draft.relating,
    assembleOptions.bureauOrgId,
    io
  );
  if ("problem" in sources) {
    io.log(`Not signed: ${printable(sources.problem)}`);
    return 1;
  }
  const { file, skipped, expired } = assembleFile(subjectRef, rows, reviewsOf, {
    ...assembleOptions,
    sources: sources.sources,
    relatingProofs: sources.relatingProofs,
  });
  if (skipped.length > 0) {
    for (const reason of skipped) io.log(printable(reason));
    io.log("Not signed: these lines' sources were not read.");
    return 1;
  }
  for (const reason of expired) {
    io.log(`Left off, its source has expired: ${printable(reason)}`);
  }
  let signed: SignedAgentFile;
  try {
    signed = signFile(file, privateKeyPem, flags["key-id"], io.keys);
  } catch (error) {
    io.log(`Not signed: ${describeError(error)}`);
    return 1;
  }
  try {
    await io.writeNewFile(flags.out, `${JSON.stringify(signed, null, 2)}\n`);
  } catch (error) {
    io.log(`Could not write ${flags.out}: ${describeError(error)}`);
    return 1;
  }
  const count = signed.furnished_outcomes.length;
  io.log(
    `File ${signed.file_id} for ${canonicalize(subjectRef)}: ${count} line${count === 1 ? "" : "s"} standing and ${signed.history.length} in history, signed with ${flags["key-id"]}, written to ${flags.out}.`
  );
  if (count + signed.history.length === 0) {
    io.log(
      expired.length > 0
        ? `No line is on the file: ${expired.length} released line${expired.length === 1 ? "" : "s"} naming this subject ${expired.length === 1 ? "was" : "were"} left off because ${expired.length === 1 ? "its source has" : "their sources have"} expired.`
        : "No released line names exactly this subject. Matching is exact apart from EVM addresses in a wallet or a did:sigvara, so check the spelling."
    );
  }
  if (log.testnet) {
    io.log(
      "The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so."
    );
  }
  return 0;
}

/** Where CounterAudit sealed a line, and what its proof must say of it. */
type SourceRef = {
  packetId: string;
  orgId: string;
  sequence: number | null;
  entryHash: string;
  signedEventHash: string;
  outcome: string;
  sealedAt: string;
};

/**
 * Reads one line's source from CounterAudit: its proof, checked against the line as verify checks
 * it, and its retention date. Failed when the proof reads but does not check; a problem when it
 * cannot be read, or when CounterAudit's record of erasing it does not check.
 */
async function readSource(
  ref: SourceRef,
  io: FileIO
): Promise<LineSource | { failed: string } | { problem: string }> {
  const fetched = await io.fetchProof(ref.packetId);
  if (fetched.ok) {
    const result = verifyLineProof({
      proof: fetched.proof,
      jwks: io.jwks,
      furnishers: io.furnishers,
      ...ref,
    });
    if (!result.ok) {
      return { failed: `its proof does not check: ${failedChecks(result.checks)}` };
    }
    const until = fetched.proof.expires_at;
    if (until === undefined || until === null) return { checkableUntil: null };
    const at = typeof until === "string" ? new Date(until).getTime() : NaN;
    if (!Number.isFinite(at)) return { problem: "its proof's expires_at is not a time" };
    return at <= io.now().getTime()
      ? { expired: `it reached its retention date, ${String(until)}` }
      : { checkableUntil: String(until) };
  }
  if (fetched.tombstone) {
    const result = verifyLineTombstone({
      tombstone: fetched.tombstone,
      jwks: io.jwks,
      packetId: ref.packetId,
      orgId: ref.orgId,
      sequence: ref.sequence,
      entryHash: ref.entryHash,
    });
    if (!result.ok) {
      return {
        problem: `CounterAudit's record of erasing it does not check: ${failedChecks(result.checks)}`,
      };
    }
    return { expired: `CounterAudit erased it at ${String(fetched.tombstone.expired_at)}` };
  }
  return { problem: `its proof could not be read: ${fetched.message}` };
}

/**
 * Reads each line's source from CounterAudit just before a file is signed: its proof, checked
 * against the line as verify checks it, and its retention date. A line whose source is erased,
 * or past that date, comes back expired. Fails closed: a proof that cannot be read or does not
 * check stops the file, so none is signed that its own verify would fail.
 *
 * The lines that dispute, withdraw, replace or correct those lines are read too, since what they
 * do shows on the file: each acts only if its proof checks now (relatingProofs). One the Bureau
 * holds as passed whose proof does not check means the store was changed or damaged, so nothing
 * is signed; one held as not passed, or erased, simply does not act. Each answer is kept by
 * packet id, which is unique in outcome_events, so no two rows share one.
 */
async function readSources(
  lines: StoredLine[],
  relating: StoredLine[],
  bureauOrgId: string,
  io: FileIO
): Promise<
  | { sources: Record<string, LineSource>; relatingProofs: Record<string, boolean> }
  | { problem: string }
> {
  // Where the intake checked a line's proof: a listed furnisher's own organization, else the
  // Bureau's, as the file states it.
  const read = async (line: StoredLine) => {
    const sealedAt = new Date(line.caCreatedAt);
    if (!Number.isFinite(sealedAt.getTime())) return { problem: "its seal time is not a time" };
    const listed = Object.hasOwn(io.furnishers, line.furnisherId)
      ? io.furnishers[line.furnisherId].counterauditOrgId
      : undefined;
    return readSource(
      {
        packetId: line.packetId,
        orgId: listed ?? bureauOrgId,
        sequence: line.sequence,
        entryHash: line.entryHash,
        signedEventHash: line.signedEventHash,
        outcome: line.outcome,
        sealedAt: sealedAt.toISOString(),
      },
      io
    );
  };
  const sources: Record<string, LineSource> = {};
  for (const line of lines) {
    const source = await read(line);
    if ("problem" in source) return { problem: `${line.packetId}: ${source.problem}` };
    if ("failed" in source) return { problem: `${line.packetId}: ${source.failed}` };
    sources[line.packetId] = source;
  }
  const relatingProofs: Record<string, boolean> = {};
  for (const r of relating) {
    if (Object.hasOwn(relatingProofs, r.packetId)) continue;
    const source = Object.hasOwn(sources, r.packetId) ? sources[r.packetId] : await read(r);
    if ("problem" in source) return { problem: `${r.packetId}: ${source.problem}` };
    if ("failed" in source) {
      if (r.proofOk) {
        return { problem: `${r.packetId}: the Bureau holds it as passed, but ${source.failed}` };
      }
      relatingProofs[r.packetId] = false;
      continue;
    }
    relatingProofs[r.packetId] = !("expired" in source);
  }
  return { sources, relatingProofs };
}

/** How long a file checked as current may have been issued before, unless --max-age-days says. */
const CURRENT_MAX_AGE_DAYS = 30;
/** pnpm file verify --current: the file's present standing could not be established. */
const NOT_ESTABLISHED = 3;

async function verifyCommand(args: string[], io: FileIO): Promise<number> {
  const offline = args.at(-1) === "--offline";
  // A file checked as it was assembled (historical), or against the review log as it is now.
  const current = args.at(-1) === "--current";
  const [path, ...rest] = offline || current ? args.slice(0, -1) : args;
  const flags = readFlags(rest);
  if (
    !path ||
    path.startsWith("--") ||
    !flags ||
    Object.keys(flags).some(k => k !== "subject" && k !== "max-age-days")
  ) {
    io.log(USAGE);
    return 2;
  }
  const expectedSubject =
    flags.subject === undefined ? null : parseSubjectFlag(flags.subject);
  if (typeof expectedSubject === "string") {
    io.log(`--subject: ${expectedSubject}.`);
    return 2;
  }
  const maxAgeDays =
    flags["max-age-days"] === undefined
      ? current
        ? CURRENT_MAX_AGE_DAYS
        : null
      : Number(flags["max-age-days"]);
  if (maxAgeDays !== null && !(Number.isFinite(maxAgeDays) && maxAgeDays > 0)) {
    io.log("--max-age-days is a positive number of days.");
    return 2;
  }
  let text: string;
  let file: unknown;
  try {
    text = await io.readText(path);
    file = JSON.parse(text);
  } catch (error) {
    io.log(`Could not read ${path} as JSON: ${describeError(error)}`);
    return 1;
  }
  const duplicate = duplicateKey(text);
  if (duplicate !== null) {
    io.log(
      `Refused: the key ${printable(duplicate)} appears twice in one object, so the file could be read two ways.`
    );
    return 1;
  }
  const signature = checkFileSignature(file, io.keys);
  io.log(
    `Bureau signature: ${signature.ok ? "verified" : `FAILED: ${printable(signature.detail)}`}`
  );
  if (!signature.ok) return 1;
  const signed = file as SignedAgentFile;
  io.log(`About: ${printable(canonicalize(signed.subject?.subject_ref))}`);
  io.log(
    `File ${printable(signed.file_id)}, issued ${printable(signed.issued_at)}, reviewers ${printable(signed.reviewers)}`
  );
  let failed = 0;
  if (expectedSubject) {
    const same =
      isRecord(signed.subject?.subject_ref) &&
      subjectKey(signed.subject.subject_ref) === subjectKey(expectedSubject);
    io.log(
      same
        ? "Subject: as expected"
        : "Subject: FAILED: this file is about another subject"
    );
    if (!same) failed++;
  }
  if (maxAgeDays !== null) {
    const issued = new Date(String(signed.issued_at)).getTime();
    const age = io.now().getTime() - issued;
    // A few minutes' clock difference is allowed; a file from the future is not.
    const fresh =
      Number.isFinite(issued) &&
      age >= -5 * 60_000 &&
      age <= maxAgeDays * 86_400_000;
    io.log(
      fresh
        ? `Age: within ${maxAgeDays} days`
        : `Age: FAILED: not issued within the last ${maxAgeDays} days`
    );
    if (!fresh) failed++;
  }
  const lines = [signed.furnished_outcomes, signed.history];
  if (!lines.every(Array.isArray)) {
    io.log("The file has no furnished_outcomes or history list.");
    return 1;
  }
  const entries = lines.flat() as unknown[];
  // Absent on a file assembled before standing was added.
  const standings = Array.isArray(signed.third_party_standing)
    ? (signed.third_party_standing as unknown[])
    : [];
  // Where the review log stood when the file was assembled (review M-01).
  const stated = signed.review_log;
  io.log(
    stated === undefined
      ? "Review log: not stated (the file was assembled before files recorded it)"
      : isRecord(stated)
        ? `Review log: assembled at sequence ${printable(stated.sequence)} (packet ${printable(stated.packet_id)})`
        : "Review log: empty when the file was assembled"
  );
  if (!current) {
    io.log(
      "Review status: as assembled. This does not say the file still stands; pnpm file verify --current checks it against the review log as it is now."
    );
  }
  if (offline) {
    io.log(
      `${entries.length} line(s) and ${standings.length} third-party fact(s); not checked against CounterAudit or the chain (--offline).`
    );
    return failed === 0 ? 0 : 1;
  }
  for (const entry of standings) {
    const source = isRecord(entry) ? entry.source : null;
    if (source !== "Sigvara") {
      failed++;
      io.log(
        `Third-party standing from ${printable(source)}: FAILED: not a source this tool can check`
      );
      continue;
    }
    const result = await checkSigvaraStanding(
      signed.subject?.subject_ref,
      entry,
      io.sigvara,
      String(signed.issued_at)
    );
    const at =
      isRecord(entry) && isRecord(entry.read_at)
        ? entry.read_at.block_number
        : null;
    const score =
      isRecord(entry) && isRecord(entry.score) ? entry.score.total : null;
    const status = isRecord(entry) ? entry.status : null;
    if (result.ok) {
      io.log(
        `Sigvara standing: verified at block ${printable(at)} (${printable(status)}, score ${printable(score)})`
      );
    } else {
      failed++;
      io.log(`Sigvara standing: FAILED: ${printable(result.detail)}`);
    }
  }
  // Each line's proof that verified, by packet: --current checks its furnisher's admission by it.
  const proofs = new Map<string, Record<string, unknown>>();
  // Each line CounterAudit's signed record says it erased, and whether that was before the file's date.
  const erasedSources = new Map<string, { at: string; early: boolean }>();
  // The signature held, but each line is still read as untrusted JSON.
  for (const entry of entries) {
    const line: Record<string, unknown> = isRecord(entry) ? entry : {};
    const ca: Record<string, unknown> = isRecord(line.counteraudit)
      ? line.counteraudit
      : {};
    const packetId = typeof ca.packet_id === "string" ? ca.packet_id : "";
    const fetched = packetId
      ? await io.fetchProof(packetId)
      : { ok: false as const, status: null, message: "no packet id" };
    // Erased under CounterAudit's retention policy: the line has expired with its source, as the
    // file said it would. Only CounterAudit's signed record of the erasure counts.
    if (!fetched.ok && fetched.tombstone) {
      const erased = verifyLineTombstone({
        tombstone: fetched.tombstone,
        jwks: io.jwks,
        packetId,
        orgId: String(ca.org_id ?? ""),
        sequence: typeof ca.sequence === "number" ? ca.sequence : null,
        entryHash: String(ca.entry_hash ?? ""),
      });
      if (erased.ok) {
        const at = String(fetched.tombstone.expired_at);
        const until = ca.checkable_until;
        const early =
          typeof until === "string" &&
          new Date(at).getTime() < new Date(until).getTime();
        erasedSources.set(packetId, { at, early });
        const stated =
          typeof until === "string"
            ? `, ${early ? "before" : "after"} the file's checkable_until (${printable(until)})`
            : "";
        io.log(
          `${printable(packetId)}: expired: CounterAudit erased its source at ${printable(at)}${stated}; the line rests on the Bureau's signature alone`
        );
      } else {
        failed++;
        io.log(
          `${printable(packetId)}: erasure record FAILED: ${failedChecks(erased.checks)}`
        );
      }
      continue;
    }
    if (!fetched.ok) {
      failed++;
      io.log(
        `${printable(packetId || "(no packet)")}: proof not fetched: ${printable(fetched.message)}`
      );
      continue;
    }
    const result = verifyLineProof({
      proof: fetched.proof,
      jwks: io.jwks,
      furnishers: io.furnishers,
      packetId,
      orgId: String(ca.org_id ?? ""),
      sequence: typeof ca.sequence === "number" ? ca.sequence : null,
      entryHash: String(ca.entry_hash ?? ""),
      signedEventHash: String(ca.signed_event_hash ?? ""),
      outcome: String(line.outcome ?? ""),
      sealedAt: String(line.sealed_at ?? ""),
    });
    if (result.ok) {
      proofs.set(packetId, fetched.proof);
      io.log(
        `${printable(packetId)}: proof verified (${printable(line.outcome)}, sealed in ${printable(ca.org_id)})`
      );
    } else {
      failed++;
      io.log(
        `${printable(packetId)}: proof FAILED: ${failedChecks(result.checks)}`
      );
    }
  }
  if (!current) {
    failed += await checkReviewLog(signed, entries, io);
    return failed === 0 ? 0 : 1;
  }
  const standing = await checkCurrentReviewStatus(signed, entries, io, proofs, erasedSources);
  if (standing === null) {
    return failed === 0 ? NOT_ESTABLISHED : 1;
  }
  failed += standing;
  return failed === 0 ? 0 : 1;
}

/**
 * Whether each released line in a file still stands in the review log as CounterAudit holds it now
 * (pnpm file verify --current, review F-03 of 1 November 2026): the whole log read and replayed,
 * its head at or past the position the file states, that position the packet the file names, the
 * decisions each line names still counted, and the line's current decisions, each reviewer's
 * latest, holding no rejection or suspended reviewer and still the approvals it needs, and a live
 * line's furnisher still admitted for the organization and key its verified proof names. Returns how
 * many checks failed, or null when the log could not be read whole, so its standing is unknown.
 */
async function checkCurrentReviewStatus(
  signed: SignedAgentFile,
  entries: unknown[],
  io: FileIO,
  proofs: Map<string, Record<string, unknown>>,
  erasedSources: Map<string, { at: string; early: boolean }>
): Promise<number | null> {
  const unknown = (why: string) => {
    io.log(`Current standing: NOT ESTABLISHED: ${printable(why)}`);
    return null;
  };
  if (!ENV.counterauditReviewOrgId || !ENV.counterauditReviewReadKey) {
    return unknown(
      "needs COUNTERAUDIT_REVIEW_ORG_ID and COUNTERAUDIT_REVIEW_READ_KEY to read the review log"
    );
  }
  // A head someone already holds, so a log that stops short of it is not taken for the whole.
  const pinned = ENV.counterauditReviewMinHead ? parseHead(ENV.counterauditReviewMinHead) : null;
  if (ENV.counterauditReviewMinHead && !pinned) {
    return unknown('COUNTERAUDIT_REVIEW_MIN_HEAD is not "sequence:entryhash"');
  }
  // The same for the Bureau's organization, which holds the dispute records and evidence seals.
  const orgPinned = ENV.counterauditMinHead ? parseHead(ENV.counterauditMinHead) : null;
  if (ENV.counterauditMinHead && !orgPinned) {
    return unknown('COUNTERAUDIT_MIN_HEAD is not "sequence:entryhash"');
  }
  let now: Awaited<ReturnType<typeof readReviewLogNow>>;
  try {
    now = await readReviewLogNow({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReviewReadKey,
      orgId: ENV.counterauditReviewOrgId,
      minHead: pinned,
      fetch: io.fetch,
      now: io.now(),
    });
  } catch (error) {
    return unknown(`the review log could not be read: ${describeError(error)}`);
  }
  if ("problem" in now) {
    return unknown(`the review log could not be read whole: ${now.problem}`);
  }
  // The evidence result sealed last for each line, every dispute record and every line, as
  // CounterAudit holds them now.
  if (!ENV.counterauditOrgId || !ENV.counterauditReadKey) {
    return unknown("needs COUNTERAUDIT_ORG_ID and COUNTERAUDIT_READ_KEY to read the evidence seals");
  }
  let seals: Awaited<ReturnType<typeof readBureauOrganization>>;
  try {
    seals = await readBureauOrganization({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReadKey,
      orgId: ENV.counterauditOrgId,
      fetch: io.fetch,
      minHead: orgPinned,
    });
  } catch (error) {
    return unknown(`the evidence seals could not be read: ${describeError(error)}`);
  }
  if ("problem" in seals) {
    return unknown(`the evidence seals could not be read: ${seals.problem}`);
  }
  let failed = 0;
  const fail = (what: string) => {
    failed++;
    io.log(`Current standing: FAILED: ${printable(what)}`);
  };
  // Why a line that fails nothing still cannot be said to stand. A failure outranks it. A dispute
  // record erased before the file was signed was judged then, with the store to say whether it went
  // with its line (storeProblems). One erased early since could be a dispute this file should show.
  const issuedAt = new Date(String(signed.issued_at)).getTime();
  const erasedEarly = seals.erasedDisputes.find(
    e => !erasedByRetention(e) && !(e.erasedAt && e.erasedAt.getTime() <= issuedAt)
  );
  let undetermined = erasedEarly
    ? `CounterAudit erased dispute packet ${erasedEarly.packetId} since the file was signed, before its retention ran out, so a dispute may be missing from this read`
    : null;
  // A CounterAudit restored behind a head attests to its stale tip, so only a head held elsewhere
  // shows the log or the organization went back (review AB-M02).
  const unpinned = [
    ...(pinned ? [] : ["COUNTERAUDIT_REVIEW_MIN_HEAD"]),
    ...(orgPinned ? [] : ["COUNTERAUDIT_MIN_HEAD"]),
  ];
  if (unpinned.length > 0) {
    undetermined ??= `${unpinned.join(" and ")} not set, so a CounterAudit restored behind a head you hold would pass: set from pnpm review head`;
  }
  const lines = seals.furnished.flatMap(sealed => lineFromSeal(sealed) ?? []);
  const unreadableLine = seals.unreadableLines[0] ?? seals.furnished.find(sealed => !lineFromSeal(sealed))?.packetId;
  if (unreadableLine) {
    undetermined ??= `outcome packet ${unreadableLine} holds no event this can read, so a line acting on this file's could be missing`;
  }
  const disputeRows = disputeRowsByLine(seals.disputes, lines);
  // A line that passes the review log's checks stands if it still shows as the file says.
  const stillShows = async (line: Record<string, unknown>, ca: Record<string, unknown>) => {
    const found = await lineNow(line, ca, proofs.get(String(ca.packet_id)), { log: now.log, disputeRows, lines }, io);
    if (found === null) standing++;
    else if ("unknown" in found) undetermined ??= found.unknown;
    else fail(found.problem);
  };
  const stated: Record<string, unknown> | null = isRecord(signed.review_log)
    ? signed.review_log
    : null;
  if (!stated) {
    fail(
      "the file does not state where the review log stood when it was assembled; assemble a new one"
    );
    return failed;
  }
  if (stated.org_id !== ENV.counterauditReviewOrgId) {
    fail(
      `the file names organization ${stated.org_id}, not the review organization`
    );
  }
  const at = now.rows.find(r => r.sequence === stated.sequence);
  if (
    !at ||
    at.packetId !== stated.packet_id ||
    at.entryHash !== stated.entry_hash
  ) {
    fail(
      `the review log has no packet ${stated.packet_id} at sequence ${stated.sequence} with that entry hash`
    );
  }
  const counted = new Set(now.log.decisions.map(d => d.packetId));
  let standing = 0;
  let expired = 0;
  for (const entry of entries) {
    const line: Record<string, unknown> = isRecord(entry) ? entry : {};
    if (!line.released) continue;
    const ca: Record<string, unknown> = isRecord(line.counteraudit)
      ? line.counteraudit
      : {};
    // Gone with its source, it no longer stands, and a new file leaves it off. That was to be
    // expected from the date the file gave, and not before it.
    const erased = erasedSources.get(String(ca.packet_id));
    if (erased) {
      if (erased.early) {
        fail(`line ${ca.packet_id}: CounterAudit erased its source at ${erased.at}, before the date the file gives; assemble a new file`);
      } else {
        expired++;
      }
      continue;
    }
    const named = Array.isArray(line.review_decisions)
      ? (line.review_decisions as unknown[])
      : [];
    if (named.length === 0) {
      fail(
        `line ${ca.packet_id} does not name the decisions it was released on`
      );
      continue;
    }
    const lost = named
      .map(item => (isRecord(item) ? item.packet_id : null))
      .filter(id => typeof id !== "string" || !counted.has(id));
    if (lost.length > 0) {
      fail(
        `line ${ca.packet_id}: decision ${lost.join(", ")} no longer counts in the review log`
      );
      continue;
    }
    // The evidence result the line was released on must still be the one sealed last for it, and
    // approvals count only for that result, on its terms (server/evidenceSeal.ts).
    const sealRef: Record<string, unknown> | null = isRecord(line.evidence_seal)
      ? line.evidence_seal
      : null;
    if (!sealRef) {
      fail(
        `line ${ca.packet_id} does not name the evidence result it was released on; assemble a new one`
      );
      continue;
    }
    if (sealRef.org_id !== ENV.counterauditOrgId) {
      fail(
        `line ${ca.packet_id} names evidence sealed in ${sealRef.org_id}, not the Bureau's organization`
      );
      continue;
    }
    const sealedLast = seals.seals.get(String(ca.signed_event_hash));
    if (!sealedLast || sealedLast.record.evidence_digest !== sealRef.evidence_digest) {
      fail(
        sealedLast
          ? `line ${ca.packet_id}: its evidence was checked again since; the result CounterAudit sealed last for it (packet ${sealedLast.packetId}) is not the one it was released on`
          : `line ${ca.packet_id}: CounterAudit holds no evidence result sealed for it`
      );
      continue;
    }
    const terms = sealedLast.record;
    if (terms.status !== "verified" && terms.status !== "needs_review") {
      fail(`line ${ca.packet_id}: its evidence is ${terms.status}, which no approval releases`);
      continue;
    }
    // Each reviewer's latest decision on this exact event and data class, as releaseFor reads them.
    const latest = new Map<string, (typeof now.log.decisions)[number]>();
    for (const d of now.log.decisions) {
      if (
        d.decision.signed_event_hash !== ca.signed_event_hash ||
        d.decision.data_class !== line.data_class
      ) {
        continue;
      }
      const seen = latest.get(d.decision.reviewer_id);
      const t = new Date(d.decision.decided_at).getTime();
      const seenAt = seen
        ? new Date(seen.decision.decided_at).getTime()
        : -Infinity;
      if (!seen || t > seenAt || (t === seenAt && d.sequence > seen.sequence)) {
        latest.set(d.decision.reviewer_id, d);
      }
    }
    const decisions = [...latest.values()];
    const suspended = decisions.filter(d => d.suspended);
    const rejected = decisions.filter(d => d.decision.decision === "reject");
    const approvals = decisions.filter(
      d =>
        (d.decision.decision === "approve" ||
          d.decision.decision === "approve_with_waiver") &&
        d.decision.evidence_digest === terms.evidence_digest &&
        (!terms.needs_waiver || d.decision.decision === "approve_with_waiver")
    ).length;
    const needed = line.data_class === "test" ? 1 : 2;
    if (suspended.length > 0) {
      fail(
        `line ${ca.packet_id} is held: ${suspended.map(d => d.decision.reviewer_id).join(", ")} decided on it and is suspended`
      );
    } else if (rejected.length > 0) {
      fail(
        `line ${ca.packet_id} was rejected by ${rejected.map(d => `${d.decision.reviewer_id} (sequence ${d.sequence})`).join(", ")}`
      );
    } else if (approvals < needed) {
      fail(
        `line ${ca.packet_id} has ${approvals} current approval(s) and needs ${needed}`
      );
    } else if (line.released === "two_person" && approvals < 2) {
      fail(
        `line ${ca.packet_id} says two reviewers released it, and has ${approvals} current approval(s); assemble a new file`
      );
    } else if (line.data_class === "live") {
      const gate = proofAdmission(
        now.log,
        proofs.get(String(ca.packet_id)),
        io.furnishers
      );
      if (!gate.admitted) fail(`line ${ca.packet_id}: ${gate.problem}`);
      else if (gate.onProbation && terms.needs_waiver) {
        fail(
          `line ${ca.packet_id}: its furnisher is on probation, when no approval can waive anything for its lines`
        );
      } else await stillShows(line, ca);
    } else {
      await stillShows(line, ca);
    }
  }
  // What the log was held to: CounterAudit's head, attested over this read's own nonce, so an old
  // answer cannot stand in for it (review AB-01).
  const cp = now.checkpoint;
  io.log(
    cp
      ? `Review log held to CounterAudit's signed checkpoint at sequence ${cp.sequence} (entry hash ${cp.entryHash}, issued ${cp.issuedAt.toISOString()}), attested as the head over this read's own nonce${
          pinned ? `, and to COUNTERAUDIT_REVIEW_MIN_HEAD at sequence ${pinned.sequence}.` : "."
        }`
      : "Review log: empty, as CounterAudit attests over this read's own nonce."
  );
  if (orgPinned) io.log(`The Bureau's organization held to COUNTERAUDIT_MIN_HEAD at sequence ${orgPinned.sequence}.`);
  if (failed === 0 && undetermined) return unknown(undetermined);
  if (failed === 0 && expired > 0) {
    io.log(`${expired} released line(s) expired with their source, as the file said they would, and do not count as standing.`);
  }
  if (failed === 0) {
    io.log(
      `Current standing: ${standing} released line(s) still stand in the review log, read whole to sequence ${now.position?.sequence ?? "none"}, and show as the dispute records and lines CounterAudit holds say`
    );
  }
  return failed;
}

// Each dispute record CounterAudit holds that a dispute can count on, by the signed event hash of
// the line its dispute names, in the order sealed. As storeSealedDisputes has it, the first dispute
// sealed with an id is the one that id means, and one it would refuse (a line it does not hold, at
// another version, or another subject) is never stored and claims no id. Whether a record counts
// is for deriveDisputes.
export function disputeRowsByLine(disputes: SealedDispute[], lines: Line[]): Map<string, StoredDisputeRecord[]> {
  const filedOn = new Map<string, string>();
  const byLine = new Map<string, StoredDisputeRecord[]>();
  for (const sealed of disputes) {
    const form = checkDisputeForm(sealed.record);
    if (!form.ok) continue;
    const { record } = form;
    if (record.kind === "dispute") {
      if (filedOn.has(record.dispute_id)) continue;
      const line = lines.find(l => l.furnisherId === record.line.furnisher_id && l.eventId === record.line.event_id);
      if (
        !line ||
        line.signedEventHash !== record.line.signed_event_hash ||
        canonicalize(record.subject_ref) !== canonicalize(line.subjectRef)
      ) {
        continue;
      }
      filedOn.set(record.dispute_id, record.line.signed_event_hash);
    }
    const hash = filedOn.get(record.dispute_id);
    if (!hash) continue;
    byLine.set(hash, [
      ...(byLine.get(hash) ?? []),
      {
        id: sealed.sequence,
        disputeId: record.dispute_id,
        kind: record.kind,
        record,
        packetId: sealed.packetId,
        sequence: sealed.sequence,
        sealedAt: sealed.sealedAt,
        signatureOk: false,
        subjectControlOk: null,
      },
    ]);
  }
  return byLine;
}

// A line as its sealed event says it, read without the Bureau's database. CounterAudit checked the
// event's signature when it sealed it. Its data class is not in the event, so lineNow gives each the
// class of the line it is judging: a line that acts on another is taken to share its class, which
// can only hold a line back, never release one.
export function lineFromSeal(sealed: SealedLine): (Line & { signedEvent: unknown }) | null {
  const fields = readEventFields(sealed.event);
  if (typeof fields === "string") return null;
  let hash: string;
  try {
    hash = signedEventHash(sealed.event);
  } catch {
    return null;
  }
  return {
    id: sealed.sequence,
    furnisherId: fields.furnisherId,
    eventId: fields.eventId,
    subjectRef: fields.subjectRef,
    dataClass: "test",
    proofOk: true,
    evidenceStatus: null,
    evidenceResult: null,
    evidenceKey: null,
    signedEventHash: hash,
    displayState: "unverified",
    relationType: fields.relationType,
    relationTargetEventId: fields.relationTargetEventId,
    caCreatedAt: sealed.sealedAt,
    signedEvent: sealed.event,
  };
}

/**
 * Whether a file's released line still shows as the file says, from what CounterAudit holds now: the
 * line's event, the lines that act on it and its dispute records, each checked again and added up by
 * the rules assembly uses (deriveDisputes, lineStates). So a dispute sealed after the file was signed,
 * one that has moved on since, or a withdrawal or correction since, fails the line without a new file
 * (review AB-M01). Null when it still shows so; `unknown` when this read cannot say.
 *
 * A did:sigvara subject's record is checked against SigvaraIdentity as it stands now, where assembly
 * uses what the sync read when it stored the record. They agree on a record sealed after the agent
 * registered, if the registry still holds it. On any other, a difference may be only that, so this
 * says it cannot tell rather than fail a line, or a fresh file, for it.
 */
export async function lineNow(
  entry: Record<string, unknown>,
  ca: Record<string, unknown>,
  proof: Record<string, unknown> | undefined,
  read: { log: ReviewLog; disputeRows: Map<string, StoredDisputeRecord[]>; lines: Array<Line & { signedEvent: unknown }> },
  io: Pick<FileIO, "furnishers" | "now" | "sigvara">
): Promise<{ problem: string } | { unknown: string } | null> {
  // A proof that failed has failed the file already.
  if (!proof) return null;
  const id = String(ca.packet_id);
  if (ca.org_id !== ENV.counterauditOrgId) {
    return { unknown: `line ${id} is sealed in ${ca.org_id}, and only the Bureau's organization was read for what acts on it` };
  }
  const dataClass = entry.data_class as Line["dataClass"];
  const lines = read.lines.map(l => ({ ...l, dataClass }));
  const target = lines.find(l => l.signedEventHash === ca.signed_event_hash);
  if (!target) {
    return { unknown: `CounterAudit's read of the Bureau's organization holds no event for line ${id}` };
  }
  const ofFurnisher = lines.filter(l => l.furnisherId === target.furnisherId);
  const relating: Line[] = ofFurnisher
    .filter(l => l.eventId !== target.eventId && l.relationTargetEventId === target.eventId)
    .map(r =>
      r.relationType !== "disputes"
        ? r
        : {
            ...r,
            displayState: ofFurnisher.some(
              w => w.relationType === "withdraws" && w.relationTargetEventId === r.eventId && relationProblem(w, r) === null
            )
              ? ("withdrawn" as const)
              : ("unverified" as const),
          }
    );
  const keyed = {
    furnisherId: target.furnisherId,
    subjectRef: target.subjectRef,
    signedEvent: target.signedEvent,
    receipt: { outcome_claim: proof.outcome_claim },
  };
  const records: CheckedDisputeRecord[] = [];
  let registryMayDiffer = false;
  try {
    for (const row of read.disputeRows.get(target.signedEventHash) ?? []) {
      const form = checkDisputeForm(row.record);
      if (!form.ok) continue;
      const control = signedByWallet(form.record) ? await readController(target.subjectRef, io.sigvara, form.record.signer.address) : null;
      if (control && (!control.ok || control.registeredAt === undefined || BigInt(Math.floor(new Date(row.sealedAt).getTime() / 1000)) < control.registeredAt)) {
        registryMayDiffer = true;
      }
      const stored = { ...row, controllerAddress: control?.controller ?? null };
      records.push({ ...stored, check: await checkStoredRecord(stored, keyed, io.furnishers) });
    }
  } catch (error) {
    return { unknown: `the dispute records on line ${id} could not be checked: ${describeError(error)}` };
  }
  const dispute = currentDispute(
    deriveDisputes({
      line: target,
      records,
      relating,
      reviewsOf: l => reviewsFor(l, read.log),
      now: io.now(),
      admissionOf: l => admissionFor(l, read.log, io.furnishers),
    })
  );
  const differs = (problem: string) =>
    registryMayDiffer ? { unknown: `${problem}, though a did:sigvara record on it may have been stored from an earlier read of SigvaraIdentity` } : { problem };
  if (dispute?.state === "lapsed") {
    return differs(
      `line ${id}: its subject's dispute, sealed at ${dispute.filedAt.toISOString()}, lapsed at ${dispute.respondBy.toISOString()} without an answer, which removes the line`
    );
  }
  const shows = dispute ? fileDispute(dispute) : null;
  if (canonicalize(shows) !== canonicalize(entry.dispute ?? null)) {
    return differs(
      `line ${id}: the dispute records CounterAudit holds say ${shows ? canonicalize(shows) : "no dispute counts"}, and the file says ${entry.dispute ? canonicalize(entry.dispute) : "none"}; assemble a new file`
    );
  }
  const display = displayStateFor({
    ...lineStates(target, relating, [], dispute?.state ?? null),
    released: entry.released as Release,
  });
  return display === entry.display_state
    ? null
    : { problem: `line ${id} now shows as ${display}, and the file says ${entry.display_state}; assemble a new file` };
}

// Whether a live line's furnisher is admitted now for the organization and key CounterAudit's
// verified proof of the line names, and whether the line was sealed during probation: the same
// gate release applies.
function proofAdmission(
  log: ReviewLog,
  proof: Record<string, unknown> | undefined,
  furnishers: Record<string, Furnisher>
): AdmissionGate {
  if (!proof) {
    return {
      admitted: false,
      problem: "its proof did not verify, so its furnisher's admission cannot be checked",
    };
  }
  return proofAdmissionGate(proof, log.admissions, furnishers);
}

/**
 * Checks a file's review-log references against the review organization (review M-01): the
 * position it states, and the decisions each line names. Review packets are not public, so
 * this needs the review organization's read key; without one it says they were not checked.
 * Returns how many checks failed.
 */
async function checkReviewLog(
  signed: SignedAgentFile,
  entries: unknown[],
  io: FileIO
): Promise<number> {
  const stated: Record<string, unknown> | null = isRecord(signed.review_log)
    ? signed.review_log
    : null;
  if (!stated) return 0;
  if (!ENV.counterauditReviewOrgId || !ENV.counterauditReviewReadKey) {
    io.log(
      "Review log: not checked against CounterAudit (needs COUNTERAUDIT_REVIEW_ORG_ID and COUNTERAUDIT_REVIEW_READ_KEY)"
    );
    return 0;
  }
  const options = {
    apiUrl: ENV.counterauditApiUrl,
    readKey: ENV.counterauditReviewReadKey,
    fetch: io.fetch,
  };
  const read = async (id: unknown) => {
    try {
      return await readReviewPacket(String(id), options);
    } catch (error) {
      return { ok: false as const, reason: describeError(error) };
    }
  };
  let failed = 0;
  const fail = (what: string) => {
    failed++;
    io.log(`Review log: FAILED: ${printable(what)}`);
  };
  if (stated.org_id !== ENV.counterauditReviewOrgId) {
    fail(
      `the file names organization ${stated.org_id}, not the review organization`
    );
  }
  const tip = await read(stated.packet_id);
  if (!tip.ok) {
    fail(`packet ${stated.packet_id}: ${tip.reason}`);
  } else if (
    tip.orgId !== stated.org_id ||
    tip.sequence !== stated.sequence ||
    tip.entryHash !== stated.entry_hash
  ) {
    fail(
      `packet ${stated.packet_id} is not at sequence ${stated.sequence} with that entry hash`
    );
  }
  let checked = 0;
  for (const entry of entries) {
    const line: Record<string, unknown> = isRecord(entry) ? entry : {};
    const ca: Record<string, unknown> = isRecord(line.counteraudit)
      ? line.counteraudit
      : {};
    if (
      !Array.isArray(line.review_decisions) ||
      line.review_decisions.length === 0
    ) {
      fail(
        `line ${ca.packet_id} does not name the decisions it was released on`
      );
      continue;
    }
    for (const item of line.review_decisions as unknown[]) {
      const ref: Record<string, unknown> = isRecord(item) ? item : {};
      const got = await read(ref.packet_id);
      if (!got.ok) {
        fail(`decision ${ref.packet_id}: ${got.reason}`);
        continue;
      }
      const record: Record<string, unknown> = isRecord(got.record)
        ? got.record
        : {};
      if (
        got.orgId !== stated.org_id ||
        typeof ref.sequence !== "number" ||
        got.sequence !== ref.sequence ||
        ref.sequence > Number(stated.sequence) ||
        record.decision !== ref.decision ||
        record.signed_event_hash !== ca.signed_event_hash
      ) {
        fail(
          `decision ${ref.packet_id} is not the ${ref.decision} at sequence ${ref.sequence} on line ${ca.packet_id}`
        );
        continue;
      }
      checked++;
    }
  }
  if (failed === 0) {
    io.log(
      `Review log: position and ${checked} decision(s) verified against the review organization`
    );
  }
  return failed;
}

/**
 * pnpm file subject: the subject's view (docs/disputes.md), every line the Bureau holds on one
 * subject that was ever released, with what a file leaves out, written for the operator to send
 * them. Read against the review log as CounterAudit holds it now, as a file is.
 */
async function subjectCommand(args: string[], io: FileIO): Promise<number> {
  const flags = readFlags(args);
  if (
    !flags ||
    !flags.subject ||
    !flags.out ||
    Object.keys(flags).length !== 2
  ) {
    io.log(USAGE);
    return 2;
  }
  const subjectRef = parseSubjectFlag(flags.subject);
  if (typeof subjectRef === "string") {
    io.log(`--subject: ${subjectRef}.`);
    return 2;
  }
  const missing = [
    ["DATABASE_URL", ENV.databaseUrl],
    ["COUNTERAUDIT_ORG_ID", ENV.counterauditOrgId],
    ["COUNTERAUDIT_REVIEW_ORG_ID", ENV.counterauditReviewOrgId],
    ["COUNTERAUDIT_REVIEW_READ_KEY", ENV.counterauditReviewReadKey],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    io.log(
      `Not set: ${missing.map(([name]) => name).join(", ")}. See docs/disputes.md.`
    );
    return 2;
  }
  if (!(await schemaReady())) {
    io.log("The database is not reachable or lacks the outcome tables.");
    return 1;
  }
  let current: Awaited<ReturnType<typeof loadCurrentReviewLog>>;
  try {
    current = await loadCurrentReviewLog({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReviewReadKey,
      orgId: ENV.counterauditReviewOrgId,
      fetch: io.fetch,
      now: io.now(),
    });
  } catch (error) {
    current = { problem: describeError(error) };
  }
  if ("problem" in current) {
    io.log(
      `Not written: the review log could not be brought up to date: ${printable(current.problem)}`
    );
    return 1;
  }
  const lines: StoredLine[] = [];
  const skipped: string[] = [];
  for (const row of (await listFileLines()) as StoredLine[]) {
    if (row.expiredAt) continue;
    const line = fromSignedEvent(await checkLineDisputes(row, io.furnishers));
    if (typeof line === "string") skipped.push(line);
    else lines.push(line);
  }
  if (skipped.length > 0) {
    for (const reason of skipped) io.log(printable(reason));
    io.log(
      "Not written: these lines' signed events do not check. Re-run the intake for them, or find out who changed them."
    );
    return 1;
  }
  const view = assembleSubjectView(subjectRef, lines, current.log, {
    now: io.now(),
    bureauOrgId: ENV.counterauditOrgId,
    proofBase: ENV.counterauditApiUrl,
    furnishers: io.furnishers,
    categories: FURNISHER_CATEGORIES,
    unlistedCategory: UNLISTED_CATEGORY,
    reviewLog: {
      orgId: ENV.counterauditReviewOrgId,
      position: current.position,
    },
  });
  try {
    await io.writeNewFile(flags.out, `${JSON.stringify(view, null, 2)}\n`);
  } catch (error) {
    io.log(`Could not write ${flags.out}: ${describeError(error)}`);
    return 1;
  }
  const disputes = view.lines.reduce((n, l) => n + l.disputes.length, 0);
  io.log(
    `Subject view for ${canonicalize(subjectRef)}: ${view.lines.length} line${view.lines.length === 1 ? "" : "s"} ever released and ${disputes} dispute${disputes === 1 ? "" : "s"}, written to ${flags.out}. It is not signed; send it to the subject.`
  );
  return 0;
}

export async function runFile(
  argv: string[],
  io: FileIO = defaultIO
): Promise<number> {
  const [command, ...args] = argv.filter(arg => arg !== "--");
  switch (command) {
    case "keygen":
      return keygen(args, io);
    case "assemble":
      return assemble(args, io);
    case "verify":
      return verifyCommand(args, io);
    case "subject":
      return subjectCommand(args, io);
    default:
      io.log(USAGE);
      return 2;
  }
}
