import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findOutcomeEvent: vi.fn(),
  insertOutcomeEvent: vi.fn(),
  schemaReady: vi.fn(),
  updateOutcomeEventProof: vi.fn(),
}));
const ca = vi.hoisted(() => ({
  fetchJwks: vi.fn(),
  fetchProof: vi.fn(),
  ingestSignedEvent: vi.fn(),
}));

vi.mock("./db", () => db);
vi.mock("./counteraudit", () => ca);

import { runIntake, type IntakeIO } from "./furnishIntake";

// The real CounterAudit output in fixtures/counteraudit (see
// outcomeProof.test.ts), so the proof check below runs for real.
const fixtures = path.resolve(import.meta.dirname, "fixtures", "counteraudit");
const read = (name: string) => readFileSync(path.join(fixtures, name), "utf8");
const signedJsonl = read("signed.jsonl");
const proof = JSON.parse(read("proof.json"));
const jwks = JSON.parse(read("jwks.json"));
const event = JSON.parse(signedJsonl.trim());

const TEST_ORG = "71689063-29f4-4d83-89a7-1d8f7fbaaf87";
const INGEST_KEY = "ca_live_should_never_be_printed";
const DB_PASSWORD = "db-password-should-never-be-printed";
const NOW = new Date("2026-10-30T19:00:00.000Z");

const packet = {
  packet_id: proof.packet_id,
  entry_hash: proof.entry_hash,
  sequence: proof.sequence,
  created_at: proof.created_at,
  raw_event_hash: proof.raw_event_hash,
  receipt: { receipt_type: "counteraudit.packet_receipt" },
};

function fakeIO(text = signedJsonl) {
  const output: string[] = [];
  const io: IntakeIO = {
    readText: vi.fn(async () => text),
    log: line => output.push(line),
    now: () => NOW,
  };
  return { io, output, printed: () => output.join("\n") };
}

beforeEach(() => {
  vi.stubEnv("COUNTERAUDIT_ORG_ID", TEST_ORG);
  vi.stubEnv("COUNTERAUDIT_INGEST_KEY", INGEST_KEY);
  vi.stubEnv("DATABASE_URL", `mysql://bureau:${DB_PASSWORD}@127.0.0.1/bureau`);
  db.schemaReady.mockResolvedValue(true);
  ca.fetchProof.mockResolvedValue({ ok: true, proof });
  ca.fetchJwks.mockResolvedValue({ ok: true, jwks });
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const fn of [...Object.values(db), ...Object.values(ca)]) {
    fn.mockReset();
  }
});

describe("runIntake", () => {
  it("refuses a run not marked as test data, naming the retention decision", async () => {
    const { io, printed } = fakeIO();
    const code = await runIntake(["events.jsonl"], io);
    expect(code).toBe(2);
    expect(printed()).toContain("--test-data");
    expect(printed()).toContain("retention decision");
    expect(io.readText).not.toHaveBeenCalled();
    expect(db.schemaReady).not.toHaveBeenCalled();
    expect(ca.ingestSignedEvent).not.toHaveBeenCalled();
  });

  it("refuses before sealing anything when the database is not ready", async () => {
    db.schemaReady.mockResolvedValue(false);
    const { io } = fakeIO();
    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(2);
    expect(ca.ingestSignedEvent).not.toHaveBeenCalled();
  });

  it("stores the signed proof's packet fields, and fails a line whose ingest response disagrees with them", async () => {
    ca.ingestSignedEvent.mockResolvedValue({
      kind: "sealed",
      status: 201,
      packet: { ...packet, entry_hash: "f".repeat(64), sequence: 7 },
    });
    db.findOutcomeEvent.mockResolvedValue(undefined);
    const { io, printed } = fakeIO();

    const code = await runIntake(["--test-data", "events.jsonl"], io);

    expect(code).toBe(1);
    const row = db.insertOutcomeEvent.mock.calls[0][0];
    expect(row).toMatchObject({ entryHash: proof.entry_hash, sequence: proof.sequence, proofOk: false });
    expect(printed()).toContain("ingest response entry_hash differs from the proof");
    expect(printed()).toContain("ingest response sequence differs from the proof");
    expect(printed()).toContain("Proofs: 0 verified, 1 failed");
  });

  it("stores a sealed line as unverified test data with three separate times", async () => {
    ca.ingestSignedEvent.mockResolvedValue({
      kind: "sealed",
      status: 201,
      packet,
    });
    db.findOutcomeEvent.mockResolvedValue(undefined);
    const { io, printed } = fakeIO();

    const code = await runIntake(["--test-data", "events.jsonl"], io);

    expect(code).toBe(0);
    expect(ca.ingestSignedEvent).toHaveBeenCalledWith(event);
    expect(ca.fetchProof).toHaveBeenCalledWith(packet.packet_id);
    expect(db.insertOutcomeEvent).toHaveBeenCalledTimes(1);
    const row = db.insertOutcomeEvent.mock.calls[0][0];
    expect(row).toMatchObject({
      furnisherId: "fur_e2etest01",
      eventId: "e2e-20261030185449",
      keyId: "e2e-2026-10",
      outcome: "delivered",
      subjectRef: event.subject_ref,
      relationType: null,
      relationTargetEventId: null,
      signedEvent: event,
      signedEventHash: proof.outcome_claim.signed_event_hash,
      packetId: packet.packet_id,
      entryHash: packet.entry_hash,
      sequence: 0,
      receipt: packet.receipt,
      proofOk: true,
      proofCheckedAt: NOW,
      displayState: "unverified",
      dataClass: "test",
    });
    // The furnisher's claim, the Bureau's receipt and CounterAudit's seal,
    // each from its own source.
    expect(row.occurredAt).toEqual(new Date("2026-10-30T18:54:49Z"));
    expect(row.receivedAt).toEqual(NOW);
    expect(row.caCreatedAt).toEqual(new Date("2026-10-30T18:55:04.529Z"));
    const times = [row.occurredAt, row.receivedAt, row.caCreatedAt].map(
      (time: Date) => time.getTime()
    );
    expect(new Set(times).size).toBe(3);

    expect(printed()).toContain("sealed (201)");
    expect(printed()).toContain("proof verified");
    expect(printed()).toContain("stored as unverified test data");
    expect(printed()).not.toContain(INGEST_KEY);
    expect(printed()).not.toContain(DB_PASSWORD);
  });

  it("treats a 200 as idempotent: the stored line keeps everything but its proof check", async () => {
    ca.ingestSignedEvent.mockResolvedValue({
      kind: "already_sealed",
      status: 200,
      packet,
    });
    db.findOutcomeEvent.mockResolvedValue({
      id: 7,
      packetId: packet.packet_id,
    });
    const { io, printed } = fakeIO();

    const code = await runIntake(["--test-data", "events.jsonl"], io);

    expect(code).toBe(0);
    expect(db.insertOutcomeEvent).not.toHaveBeenCalled();
    expect(db.updateOutcomeEventProof).toHaveBeenCalledTimes(1);
    const [id, update] = db.updateOutcomeEventProof.mock.calls[0];
    expect(id).toBe(7);
    expect(Object.keys(update).sort()).toEqual([
      "proofCheckedAt",
      "proofChecks",
      "proofOk",
    ]);
    expect(update.proofOk).toBe(true);
    expect(printed()).toContain("already sealed (200)");
    expect(printed()).toContain("already stored");
  });

  it("leaves a stored line alone when a resubmission's proof cannot be fetched", async () => {
    ca.ingestSignedEvent.mockResolvedValue({
      kind: "already_sealed",
      status: 200,
      packet,
    });
    ca.fetchProof.mockResolvedValue({
      ok: false,
      status: 503,
      message: "This proof cannot be produced right now",
    });
    db.findOutcomeEvent.mockResolvedValue({
      id: 7,
      packetId: packet.packet_id,
    });
    const { io } = fakeIO();

    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(1);
    expect(db.insertOutcomeEvent).not.toHaveBeenCalled();
    expect(db.updateOutcomeEventProof).not.toHaveBeenCalled();
  });

  it("stores a sealed line whose proof fails, with the failed checks, and exits 1", async () => {
    vi.stubEnv("COUNTERAUDIT_ORG_ID", "00000000-0000-4000-8000-000000000000");
    ca.ingestSignedEvent.mockResolvedValue({
      kind: "sealed",
      status: 201,
      packet,
    });
    db.findOutcomeEvent.mockResolvedValue(undefined);
    const { io, printed } = fakeIO();

    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(1);
    const row = db.insertOutcomeEvent.mock.calls[0][0];
    expect(row.proofOk).toBe(false);
    expect(row.proofChecks.org_id.ok).toBe(false);
    expect(row.displayState).toBe("unverified");
    expect(printed()).toContain("proof FAILED (org_id)");
  });

  it.each([
    {
      kind: "conflict",
      status: 409,
      error: "outcome_event_conflict",
      message: "fur_e2etest01 already sealed a different event",
    },
    {
      kind: "refused",
      status: 422,
      error: "outcome_signer_unknown",
      message: "This organization has no active key",
    },
  ])("reports a $status and stores nothing", async result => {
    ca.ingestSignedEvent.mockResolvedValue(result);
    const { io, printed } = fakeIO();

    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(1);
    expect(printed()).toContain(`${result.status} ${result.error}`);
    expect(printed()).toContain("Not stored.");
    expect(ca.fetchProof).not.toHaveBeenCalled();
    expect(db.findOutcomeEvent).not.toHaveBeenCalled();
    expect(db.insertOutcomeEvent).not.toHaveBeenCalled();
    expect(db.updateOutcomeEventProof).not.toHaveBeenCalled();
  });

  it("does not send a line that is not a signed v1 event", async () => {
    const { io, printed } = fakeIO('{"furnisher_id": "fur_x"}\nnot json\n');
    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(1);
    expect(ca.ingestSignedEvent).not.toHaveBeenCalled();
    expect(printed()).toContain("line 1: not sent");
    expect(printed()).toContain("line 2: not sent: not valid JSON");
  });
});
