// A line expires with its CounterAudit source (decision of 1 November 2026):
// once CounterAudit erases the packet that sealed a line under its retention
// policy, the Bureau erases its own copy of what the line says. pnpm lines
// expire reads each stored line's public proof, and erases a line's content
// when CounterAudit's signed record of the erasure checks out, or when the
// proof's expires_at has passed. The row stays, holding ids, hashes, the
// outcome and times but nothing about the subject, so the event cannot be
// stored again as a new line and the review log's decisions keep their line.
// See docs/agent-file.md, "When a line's source expires".
import { ENV } from "./_core/env";
import { fetchProof } from "./counteraudit";
import { COUNTERAUDIT_EXPORT_KEYS } from "./counterauditKeys";
import { eraseOutcomeEventContent, listExpiryLines, schemaReady } from "./db";
import { FURNISHERS, type Furnisher } from "./furnishers";
import { relationProblem, type Line } from "./lineState";
import {
  verifyLineProof,
  verifyLineTombstone,
  type CheckResult,
  type Jwks,
} from "./outcomeProof";

/** A stored line, as listExpiryLines reads it. */
export type ExpiryLine = Line & {
  outcome: string;
  caCreatedAt: Date | string;
  packetId: string;
  entryHash: string;
  sequence: number | null;
  expiredAt: Date | string | null;
};

/** What CounterAudit says of a line's source, or why it could not be read. */
export type SourceState =
  | { kind: "current"; until: string | null }
  | { kind: "expired"; reason: string }
  | { kind: "unknown"; problem: string };

// The proof's checks that say which packet it is. The others say what the
// packet holds; a line whose content no longer checks still has a retention
// date worth reading.
const IDENTITY_CHECKS = [
  "proof_signature",
  "proof_type",
  "org_id",
  "packet_id",
  "sequence",
  "entry_hash",
] as const;

export type LinesIO = {
  log(line: string): void;
  now(): Date;
  fetchProof: typeof fetchProof;
  jwks: Jwks;
  furnishers: Record<string, Furnisher>;
};

const defaultIO: LinesIO = {
  log: line => console.log(line),
  now: () => new Date(),
  fetchProof,
  jwks: COUNTERAUDIT_EXPORT_KEYS,
  furnishers: FURNISHERS,
};

export const USAGE = ["Usage:", "  pnpm lines expire [--dry-run]"].join("\n");

const iso = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).toISOString();

function failed(checks: Record<string, CheckResult>, names: readonly string[]) {
  return names
    .filter(name => !checks[name].ok)
    .map(
      name => `${name}${checks[name].detail ? `: ${checks[name].detail}` : ""}`
    )
    .join("; ");
}

/**
 * Reads a line's source: its public proof, which must be CounterAudit's for
 * that packet in the organization the line came from, or CounterAudit's signed
 * record of erasing it.
 */
export async function readLineSource(
  line: ExpiryLine,
  io: LinesIO,
  bureauOrgId: string
): Promise<SourceState> {
  // A listed furnisher's lines were sealed in its own organization.
  const orgId = Object.hasOwn(io.furnishers, line.furnisherId)
    ? io.furnishers[line.furnisherId].counterauditOrgId
    : bureauOrgId;
  const fetched = await io.fetchProof(line.packetId);
  if (fetched.ok) {
    const result = verifyLineProof({
      proof: fetched.proof,
      jwks: io.jwks,
      furnishers: io.furnishers,
      packetId: line.packetId,
      orgId,
      sequence: line.sequence,
      entryHash: line.entryHash,
      signedEventHash: line.signedEventHash,
      outcome: line.outcome,
      sealedAt: iso(line.caCreatedAt),
    });
    if (!IDENTITY_CHECKS.every(name => result.checks[name].ok)) {
      return {
        kind: "unknown",
        problem: `its proof is not CounterAudit's for this packet: ${failed(result.checks, IDENTITY_CHECKS)}`,
      };
    }
    const until = fetched.proof.expires_at;
    if (until === undefined || until === null) {
      return { kind: "current", until: null };
    }
    const at = typeof until === "string" ? new Date(until).getTime() : NaN;
    if (!Number.isFinite(at)) {
      return {
        kind: "unknown",
        problem: "its proof's expires_at is not a time",
      };
    }
    return at <= io.now().getTime()
      ? {
          kind: "expired",
          reason: `it reached its retention date, ${String(until)}`,
        }
      : { kind: "current", until: String(until) };
  }
  if (fetched.tombstone) {
    const result = verifyLineTombstone({
      tombstone: fetched.tombstone,
      jwks: io.jwks,
      packetId: line.packetId,
      orgId,
      sequence: line.sequence,
      entryHash: line.entryHash,
    });
    if (!result.ok) {
      return {
        kind: "unknown",
        problem: `CounterAudit's record of erasing it does not check: ${failed(result.checks, Object.keys(result.checks))}`,
      };
    }
    return {
      kind: "expired",
      reason: `CounterAudit erased it at ${String(fetched.tombstone.expired_at)}`,
    };
  }
  return {
    kind: "unknown",
    problem: `its proof could not be read: ${fetched.message}`,
  };
}

/**
 * What an expired line keeps: nothing about its subject. The signed event, the
 * subject, the evidence result and the settlement claim (which names an
 * on-chain transfer, and so its payer), and CounterAudit's receipt go. The
 * evidence check refuses a charge older than the retention baseline, so the
 * claim is not needed to keep one charge from backing two lines.
 */
export function erasedColumns(at: Date, reason: string) {
  return {
    subjectRef: null,
    signedEvent: null,
    evidenceResult: null,
    evidenceKey: null,
    receipt: null,
    proofOk: false,
    proofChecks: { source_expired: { ok: false, detail: reason } },
    proofCheckedAt: at,
    displayState: "unverified" as const,
    expiredAt: at,
  };
}

/**
 * The line this one still acts on, if erasing it now would stop that: a
 * withdrawal or replacement whose target still stands would put the target
 * back, and a dispute would vanish from it. Such a line waits until its target
 * expires too, which a line sealed later than its target normally does after.
 */
function heldBy(
  line: ExpiryLine,
  rows: ExpiryLine[],
  due: Map<number, string>
): ExpiryLine | null {
  if (!line.relationType || !line.relationTargetEventId) return null;
  const target = rows.find(
    r =>
      r.furnisherId === line.furnisherId &&
      r.eventId === line.relationTargetEventId
  );
  if (!target || target.expiredAt || due.has(target.id)) return null;
  if (relationProblem(line, target) !== null) return null;
  if (line.relationType === "disputes" && line.displayState === "withdrawn") {
    return null;
  }
  return target;
}

export async function runLines(
  args: string[],
  io: LinesIO = defaultIO
): Promise<number> {
  const [command, ...flags] = args;
  if (command !== "expire" || flags.some(f => f !== "--dry-run")) {
    io.log(USAGE);
    return 2;
  }
  const dryRun = flags.includes("--dry-run");
  const missing = [
    ["DATABASE_URL", ENV.databaseUrl],
    ["COUNTERAUDIT_ORG_ID", ENV.counterauditOrgId],
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
  const rows = (await listExpiryLines()) as ExpiryLine[];
  const live = rows.filter(r => !r.expiredAt);
  const label = (line: ExpiryLine) =>
    `${line.furnisherId}/${line.eventId} (packet ${line.packetId})`;

  const due = new Map<number, string>();
  let unknown = 0;
  for (const line of live) {
    const source = await readLineSource(line, io, ENV.counterauditOrgId);
    if (source.kind === "expired") due.set(line.id, source.reason);
    if (source.kind === "unknown") {
      unknown++;
      io.log(`${label(line)}: not checked: ${source.problem}`);
    }
  }

  let erased = 0;
  let held = 0;
  for (const line of live) {
    const reason = due.get(line.id);
    if (!reason) continue;
    const target = heldBy(line, rows, due);
    if (target) {
      held++;
      io.log(
        `${label(line)}: held: ${reason}, but it ${line.relationType} ${target.eventId}, whose source has not expired; it is erased with that line`
      );
      continue;
    }
    if (dryRun) {
      erased++;
      io.log(`${label(line)}: would be erased: ${reason}`);
      continue;
    }
    if (
      await eraseOutcomeEventContent(line.id, erasedColumns(io.now(), reason))
    ) {
      erased++;
      io.log(`${label(line)}: erased: ${reason}`);
    }
  }

  io.log(
    `${live.length} line${live.length === 1 ? "" : "s"} checked (${rows.length - live.length} expired before): ${erased} ${dryRun ? "would be erased" : "erased"}, ${held} held, ${unknown} not checked.`
  );
  // A line that could not be checked, or that outlives its source, needs a person.
  return unknown + held > 0 ? 1 : 0;
}
