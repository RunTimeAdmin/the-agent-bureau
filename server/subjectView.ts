// The subject's view (docs/disputes.md, "The subject's view"): every line the
// Bureau holds on one subject that reviewers ever released, with what a file
// leaves out: the furnisher, the signed event, the CounterAudit packet, what the
// evidence check proved and what it did not, the payer-independence screen, the
// review decisions and their review-log packets, the lines relating to it, and
// each dispute with its records. The operator sends it to the subject on
// request, free (bureau-spec.md). Run as pnpm file subject (server/agentFile.ts).
import type { StoredLine } from "./agentFile";
import {
  DISPUTE_SCHEMA,
  RESPONSE_DAYS,
  currentDispute,
  deriveDisputes,
  type CheckedDisputeRecord,
  type Dispute,
} from "./dispute";
import type { Furnisher } from "./furnishers";
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
import { isRecord } from "./outcomeProof";
import { evidenceLabel, PAYMENT_OUTCOMES } from "./review";
import type { ReviewLog } from "./reviewLog";
import { reviewsFor, type ReviewLogPosition } from "./settleLines";

export const SUBJECT_VIEW_SCHEMA = "agent-bureau/subject-view/v1";

const SUBJECT_CONTROL_UNPROVEN =
  "That the subject controls the wallet or agent the line names: subject control is unproven until Phase 3.";
const PAYMENT_UNPROVEN =
  "A settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered.";

export const SUBJECT_VIEW_NOTES = [
  "This lists every line the Bureau holds on exactly this subject reference that reviewers released at some point, as the review log shows it, with what a file leaves out. Lines never released, and lines erased with their source, are not listed.",
  "It is not signed. A file the Bureau signs for others to read carries only the released lines, by furnisher category, with any dispute beside them.",
];

export const HOW_TO_DISPUTE = [
  `To dispute a line, write a record with schema ${DISPUTE_SCHEMA} and kind dispute: a new lowercase UUID as dispute_id; line, with the furnisher_id, event_id and signed_event_hash listed here; subject_ref exactly as in the line's signed_event; signer, {"type":"eip191","address":<your wallet>}; a reason of 1 to 500 characters; up to 5 evidence items ({"tx_hash"}, {"url"} or {"note"}); and filed_at, the time in UTC with milliseconds. Sign it with personal_sign (EIP-191) over "${DISPUTE_SCHEMA}" and a newline, followed by the record without its signature as RFC 8785 canonical JSON, using the wallet the line names (for a did:sigvara, the agent address SigvaraIdentity holds), and send it to the operator. docs/disputes.md lists every field.`,
  `The line shows as disputed on every file from then. The furnisher has ${RESPONSE_DAYS} days from when the dispute is sealed to confirm the line with evidence, correct it or withdraw it. A line it does not answer in time is removed from every file for good.`,
  "Once the furnisher confirms, you may add one statement (kind statement, with text and stated_at), which files show beside the line, and you may appeal once (kind appeal, party subject, with a reason and appealed_at). Reviewers decide an appeal: a rejection of the line upholds it.",
  "A line can carry one open dispute at a time.",
];

export type SubjectViewOptions = {
  now: Date;
  /** The Bureau's own CounterAudit organization, where unlisted furnishers' lines are sealed. */
  bureauOrgId: string;
  proofBase: string;
  furnishers: Record<string, Furnisher>;
  categories: Record<string, string>;
  unlistedCategory: string;
  reviewLog: { orgId: string; position: ReviewLogPosition | null };
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

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

/** Whether reviewers released the line at some point: after any decision in the log, in order. */
function everReleased(line: Line, reviews: Review[]): boolean {
  const ordered = [...reviews].sort((a, b) => a.id - b.id);
  return ordered.some(
    (_, i) => releaseFor(line, ordered.slice(0, i + 1)).released !== null
  );
}

// Each dispute on the line, counted or not, with its records and what checking
// each again found.
function disputeEntries(records: CheckedDisputeRecord[], derived: Dispute[]) {
  const ids = [...new Set(records.map(r => r.disputeId))];
  return ids.map(id => {
    const dispute = derived.find(d => d.disputeId === id);
    const rows = records.filter(r => r.disputeId === id);
    return {
      dispute_id: id,
      // A dispute whose own record did not check counts for nothing.
      state: dispute ? dispute.state : ("not_counted" as const),
      ...(dispute
        ? {
            filed_at: dispute.filedAt.toISOString(),
            respond_by: dispute.respondBy.toISOString(),
            ...(dispute.confirmedAt
              ? { confirmed_at: dispute.confirmedAt.toISOString() }
              : {}),
            ...(dispute.statement !== null
              ? { statement: dispute.statement }
              : {}),
            appeal: dispute.appeal && {
              party: dispute.appeal.party,
              state: dispute.appeal.state,
              sealed_at: dispute.appeal.sealedAt.toISOString(),
              packet_id: dispute.appeal.packetId,
              ...(dispute.appeal.correctiveEventId
                ? { corrective_event_id: dispute.appeal.correctiveEventId }
                : {}),
            },
          }
        : {}),
      records: rows.map(r => ({
        kind: r.kind,
        packet_id: r.packetId,
        sequence: r.sequence,
        sealed_at: iso(r.sealedAt),
        signature_checked: r.check.signatureOk,
        subject_control_checked: r.check.subjectControlOk,
        problem: r.check.problem,
        ...(r.controllerAddress
          ? { sigvara_agent_address: r.controllerAddress }
          : {}),
        record: asRecord(r.record),
      })),
    };
  });
}

export type SubjectView = ReturnType<typeof assembleSubjectView>;

/**
 * The subject's view of every line about exactly this subject that reviewers
 * ever released, or that the subject disputed, which needs a release first.
 * Pure: the caller reads the lines from their signed events, with their dispute
 * records checked again (checkLineDisputes), and the review log.
 */
export function assembleSubjectView(
  subjectRef: Record<string, unknown>,
  lines: StoredLine[],
  log: ReviewLog,
  options: SubjectViewOptions
) {
  const key = subjectKey(subjectRef);
  const reviewsOf = (line: Line) => reviewsFor(line, log);
  const proofBase = options.proofBase.replace(/\/+$/, "");
  const out = [];
  for (const line of lines) {
    if (!line.subjectRef || subjectKey(line.subjectRef) !== key) continue;
    const relating = lines.filter(
      r =>
        r.furnisherId === line.furnisherId &&
        r.relationTargetEventId === line.eventId
    );
    const reviews = reviewsOf(line);
    if (!line.checkedDisputes && line.disputeRecords?.length) {
      throw new Error(
        `${line.furnisherId}/${line.eventId}: its dispute records were not checked`
      );
    }
    const records = line.checkedDisputes ?? [];
    const derived = deriveDisputes({
      line,
      records,
      relating,
      reviewsOf,
      now: options.now,
    });
    const disputes = disputeEntries(records, derived);
    if (!everReleased(line, reviews) && disputes.length === 0) continue;
    const dispute = currentDispute(derived);
    const display: DisplayState = displayStateFor(
      lineStates(line, relating, reviews, dispute?.state ?? null)
    );
    const release: { released: Release | null; holdingBack: string | null } =
      releaseFor(line, reviews);
    const evidence = asRecord(line.evidenceResult);
    const listed = Object.hasOwn(options.furnishers, line.furnisherId)
      ? options.furnishers[line.furnisherId].counterauditOrgId
      : undefined;
    const payment = PAYMENT_OUTCOMES.has(line.outcome);
    out.push({
      furnisher_id: line.furnisherId,
      furnisher_category: Object.hasOwn(options.categories, line.furnisherId)
        ? options.categories[line.furnisherId]
        : options.unlistedCategory,
      event_id: line.eventId,
      outcome: line.outcome,
      occurred_at: iso(line.occurredAt),
      received_at: iso(line.receivedAt),
      sealed_at: iso(line.caCreatedAt),
      data_class: line.dataClass,
      display_state: display,
      signed_event: asRecord(line.signedEvent),
      counteraudit: {
        packet_id: line.packetId,
        org_id: listed ?? options.bureauOrgId,
        sequence: line.sequence,
        entry_hash: line.entryHash,
        signed_event_hash: line.signedEventHash,
        proof_url: `${proofBase}/v1/proofs/${encodeURIComponent(line.packetId)}`,
      },
      evidence: {
        status: line.evidenceStatus,
        proved:
          line.evidenceStatus === "verified"
            ? evidenceLabel(line.outcome, "verified")
            : null,
        not_proved: payment
          ? [SUBJECT_CONTROL_UNPROVEN, PAYMENT_UNPROVEN]
          : [SUBJECT_CONTROL_UNPROVEN],
        result: evidence,
      },
      ...(payment
        ? {
            payment: {
              subject_control: "unproven" as const,
              payer_independence_screen: isRecord(evidence?.funding_screen)
                ? evidence.funding_screen
                : null,
            },
          }
        : {}),
      release: {
        released: release.released,
        holding_back: release.holdingBack,
        decisions: log.decisions
          .filter(
            d =>
              d.decision.furnisher_id === line.furnisherId &&
              d.decision.event_id === line.eventId
          )
          .map(d => ({
            reviewer_id: d.decision.reviewer_id,
            decision: d.decision.decision,
            ...(d.decision.reason !== undefined
              ? { reason: d.decision.reason }
              : {}),
            decided_at: d.decision.decided_at,
            for_this_event:
              d.decision.signed_event_hash === line.signedEventHash,
            review_log: {
              org_id: options.reviewLog.orgId,
              sequence: d.sequence,
              packet_id: d.packetId,
            },
            ...(d.suspended ? { reviewer_suspended: true } : {}),
          })),
      },
      // Lines naming another subject are left out: they are someone else's.
      correction_history: relating
        .filter(r => r.subjectRef && subjectKey(r.subjectRef) === key)
        .map(r => {
          const problem = relationProblem(r, line);
          return {
            event_id: r.eventId,
            relation: r.relationType,
            acts: problem === null,
            ...(problem ? { not_acting_because: problem } : {}),
            outcome: r.outcome,
            sealed_at: iso(r.caCreatedAt),
            packet_id: r.packetId,
            signed_event: asRecord(r.signedEvent),
          };
        }),
      disputes,
    });
  }
  out.sort(
    (a, b) =>
      b.occurred_at.localeCompare(a.occurred_at) ||
      a.counteraudit.packet_id.localeCompare(b.counteraudit.packet_id)
  );
  const position = options.reviewLog.position;
  return {
    schema: SUBJECT_VIEW_SCHEMA,
    issued_at: options.now.toISOString(),
    subject: { subject_ref: subjectRef, matching: "exact" as const },
    review_log: position
      ? {
          org_id: options.reviewLog.orgId,
          sequence: position.sequence,
          entry_hash: position.entryHash,
          packet_id: position.packetId,
        }
      : null,
    lines: out,
    how_to_dispute: HOW_TO_DISPUTE,
    notes: SUBJECT_VIEW_NOTES,
  };
}
