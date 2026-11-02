// pnpm lines seal-evidence [--dry-run]: seals the stored evidence result of each line that has
// never had one sealed, in the Bureau's organization (server/evidenceSeal.ts). Lines stored
// before evidence was sealed have none, and a file stops at a released line without one; those
// whose event_id is not a UUIDv4 cannot be sent through the intake again to get one. Run it
// once, when the intake starts sealing. It trusts the stored result that one time, so it never
// seals over a line that has a seal: a line whose stored result is not the one sealed last is
// reported, for a fresh check by the intake.
import { ENV } from "./_core/env";
import { ingestEvidenceRecord, type DisputeIngestResult } from "./counteraudit";
import { listEvidenceLines, schemaReady } from "./db";
import type { EvidenceResult } from "./evidence";
import { checkEvidenceRecord, evidenceRecordFor, readEvidenceSeals, sealFor } from "./evidenceSeal";
import { isRecord } from "./outcomeProof";
import { evidenceDigest } from "./reviewDecision";
import type { Fetch } from "./reviewLogSync";

export type SealEvidenceIO = {
  log(line: string): void;
  now(): Date;
  fetch?: Fetch;
  ingest?: (record: Record<string, unknown>) => Promise<DisputeIngestResult>;
};

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

export async function runSealEvidence(flags: string[], io: SealEvidenceIO): Promise<number> {
  const dryRun = flags.includes("--dry-run");
  const missing = [
    ["DATABASE_URL", ENV.databaseUrl],
    ["COUNTERAUDIT_ORG_ID", ENV.counterauditOrgId],
    ["COUNTERAUDIT_INGEST_KEY", ENV.counterauditIngestKey],
    ["COUNTERAUDIT_READ_KEY", ENV.counterauditReadKey],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    io.log(`Not set: ${missing.map(([name]) => name).join(", ")}. See docs/agent-file.md.`);
    return 2;
  }
  if (!(await schemaReady())) {
    io.log("The database is not reachable or lacks the outcome tables.");
    return 1;
  }
  let seals: Awaited<ReturnType<typeof readEvidenceSeals>>;
  try {
    seals = await readEvidenceSeals({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReadKey,
      orgId: ENV.counterauditOrgId,
      fetch: io.fetch,
    });
  } catch (error) {
    seals = { problem: error instanceof Error ? error.message : String(error) };
  }
  if ("problem" in seals) {
    io.log(`Nothing sealed: the evidence seals could not be read: ${seals.problem}`);
    return 1;
  }
  const ingest = io.ingest ?? ingestEvidenceRecord;
  let lines = 0;
  let sealed = 0;
  let already = 0;
  let other = 0;
  let failed = 0;
  for (const row of await listEvidenceLines()) {
    // Erased with its source, or never checked: nothing to seal.
    if (row.expiredAt) continue;
    const result = asRecord(row.evidenceResult);
    if (!result) continue;
    lines++;
    const label = `${row.furnisherId}/${row.eventId}`;
    const seal = sealFor(seals.seals, row);
    if (seal) {
      if (seal.record.evidence_digest === evidenceDigest(row.evidenceResult)) {
        already++;
      } else {
        other++;
        io.log(
          `${label}: not sealed: CounterAudit sealed another result for it last (packet ${seal.packetId}); run the intake again for a fresh check`
        );
      }
      continue;
    }
    const checkedAt = row.evidenceCheckedAt ? new Date(row.evidenceCheckedAt) : io.now();
    const record = evidenceRecordFor(
      row,
      result as unknown as EvidenceResult,
      Number.isFinite(checkedAt.getTime()) ? checkedAt : io.now()
    );
    const form = checkEvidenceRecord(record);
    if (!form.ok) {
      failed++;
      io.log(`${label}: not sealed: its stored result does not make an evidence record: ${form.reason}`);
      continue;
    }
    if (dryRun) {
      sealed++;
      io.log(`${label}: would seal its stored result (${record.status})`);
      continue;
    }
    const got = await ingest(form.record);
    if (got.kind === "refused") {
      failed++;
      io.log(`${label}: not sealed (${got.status ?? "no answer"}: ${got.message}); run again to seal it`);
    } else {
      sealed++;
      io.log(`${label}: sealed its stored result (${record.status}) as packet ${got.packet.packet_id}`);
    }
  }
  io.log(
    `${lines} line${lines === 1 ? "" : "s"} with an evidence result: ${sealed} ${dryRun ? "would be sealed" : "sealed"}, ${already} already sealed, ${other} sealed with another result, ${failed} not sealed.`
  );
  return other + failed > 0 ? 1 : 0;
}
