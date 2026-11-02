import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ schemaReady: vi.fn(), listEvidenceLines: vi.fn() }));
const seals = vi.hoisted(() => ({ readEvidenceSeals: vi.fn() }));
vi.mock("./db", () => db);
vi.mock("./evidenceSeal", async importOriginal => {
  const actual = await importOriginal<typeof import("./evidenceSeal")>();
  return { ...actual, readEvidenceSeals: seals.readEvidenceSeals };
});

import { runSealEvidence } from "./evidenceBackfill";
import { EVIDENCE_SCHEMA, type SealedEvidence } from "./evidenceSeal";
import { runLines } from "./lineExpiry";
import { evidenceDigest } from "./reviewDecision";

const NOW = new Date("2026-11-02T14:00:00.000Z");
const RESULT = { verifier: "levy-arc/1", status: "needs_review", reasons: ["no machine check exists for delivered outcomes"] };
const row = (n: number, changes: Record<string, unknown> = {}) => ({
  id: n,
  furnisherId: "fur_levymerchant1",
  eventId: `levy-sub8-charge${n}`,
  signedEventHash: String(n).repeat(64).slice(0, 64),
  evidenceResult: RESULT,
  evidenceCheckedAt: new Date("2026-10-31T11:00:00.000Z"),
  expiredAt: null,
  ...changes,
});
// The seal CounterAudit holds for a line, of this digest.
const sealOf = (line: ReturnType<typeof row>, digest: string): [string, SealedEvidence] => [
  line.signedEventHash,
  {
    packetId: `e0000000-0000-4000-8000-00000000000${line.id}`,
    sequence: line.id,
    record: {
      schema: EVIDENCE_SCHEMA,
      furnisher_id: line.furnisherId,
      event_id: line.eventId,
      signed_event_hash: line.signedEventHash,
      evidence_digest: digest,
      status: "needs_review",
      needs_waiver: true,
      checked_at: "2026-10-31T11:00:00.000Z",
    },
  },
];

function io() {
  const out: string[] = [];
  const ingest = vi.fn(async () => ({
    kind: "sealed" as const,
    packet: {
      packet_id: "e0000000-0000-4000-8000-0000000000aa",
      entry_hash: "e".repeat(64),
      sequence: 9,
      created_at: NOW.toISOString(),
      raw_event_hash: "f".repeat(64),
      receipt: null,
    },
  }));
  return { out, ingest, io: { log: (l: string) => out.push(l), now: () => NOW, ingest } };
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "mysql://test");
  vi.stubEnv("COUNTERAUDIT_ORG_ID", "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1");
  vi.stubEnv("COUNTERAUDIT_INGEST_KEY", "ca_ingest");
  vi.stubEnv("COUNTERAUDIT_READ_KEY", "ca_read");
  db.schemaReady.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("pnpm lines seal-evidence", () => {
  const never = row(1);
  const same = row(2);
  const other = row(3);
  const expired = row(4, { expiredAt: new Date("2026-11-01T00:00:00.000Z") });
  const unchecked = row(5, { evidenceResult: null });
  beforeEach(() => {
    db.listEvidenceLines.mockResolvedValue([never, same, other, expired, unchecked]);
    seals.readEvidenceSeals.mockResolvedValue({
      seals: new Map([sealOf(same, evidenceDigest(RESULT)), sealOf(other, "f".repeat(64))]),
    });
  });

  it("seals only a line that never had a seal, and never over one CounterAudit holds", async () => {
    const run = io();
    expect(await runSealEvidence([], run.io)).toBe(1);
    expect(run.ingest).toHaveBeenCalledTimes(1);
    expect(run.ingest).toHaveBeenCalledWith({
      schema: EVIDENCE_SCHEMA,
      furnisher_id: never.furnisherId,
      event_id: never.eventId,
      signed_event_hash: never.signedEventHash,
      evidence_digest: evidenceDigest(RESULT),
      status: "needs_review",
      needs_waiver: true,
      checked_at: "2026-10-31T11:00:00.000Z",
    });
    const printed = run.out.join("\n");
    expect(printed).toContain(
      "fur_levymerchant1/levy-sub8-charge1: sealed its stored result (needs_review) as packet e0000000-0000-4000-8000-0000000000aa"
    );
    expect(printed).toContain(
      "fur_levymerchant1/levy-sub8-charge3: not sealed: CounterAudit sealed another result for it last (packet e0000000-0000-4000-8000-000000000003); run the intake again for a fresh check"
    );
    expect(printed).toContain(
      "3 lines with an evidence result: 1 sealed, 1 already sealed, 1 sealed with another result, 0 not sealed."
    );
  });

  it("says what it would seal with --dry-run, through pnpm lines, and seals nothing", async () => {
    const run = io();
    db.listEvidenceLines.mockResolvedValue([never, same]);
    expect(await runLines(["seal-evidence", "--dry-run"], { ...run.io, fetchProof: vi.fn(), jwks: { keys: [] }, furnishers: {} })).toBe(0);
    expect(run.out.join("\n")).toContain("fur_levymerchant1/levy-sub8-charge1: would seal its stored result (needs_review)");
    expect(run.out.join("\n")).toContain("2 lines with an evidence result: 1 would be sealed, 1 already sealed");
  });

  it("needs the Bureau's keys, and seals nothing when the seals cannot be read", async () => {
    vi.stubEnv("COUNTERAUDIT_READ_KEY", "");
    const keyless = io();
    expect(await runSealEvidence([], keyless.io)).toBe(2);
    expect(keyless.out.join("\n")).toContain("Not set: COUNTERAUDIT_READ_KEY");
    vi.stubEnv("COUNTERAUDIT_READ_KEY", "ca_read");
    seals.readEvidenceSeals.mockResolvedValue({ problem: "CounterAudit answered 503 when listing the organization's packets" });
    const unread = io();
    expect(await runSealEvidence([], unread.io)).toBe(1);
    expect(unread.ingest).not.toHaveBeenCalled();
    expect(unread.out.join("\n")).toContain("Nothing sealed: the evidence seals could not be read");
  });
});
