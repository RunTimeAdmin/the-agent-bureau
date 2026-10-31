import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findOtherOutcomeEventWithEvidence: vi.fn(),
  findRelatingOutcomeLines: vi.fn(),
  getOutcomeLine: vi.fn(),
  listReviewsForLine: vi.fn(),
  setOutcomeEventDisplayState: vi.fn(),
  findOutcomeEvent: vi.fn(),
  insertOutcomeEvent: vi.fn(),
  schemaReady: vi.fn(),
  updateOutcomeEventEvidence: vi.fn(),
  updateOutcomeEventProof: vi.fn(),
}));
const ca = vi.hoisted(() => ({
  fetchJwks: vi.fn(),
  fetchProof: vi.fn(),
  ingestSignedEvent: vi.fn(),
}));
// The real evidence check unless a test says otherwise. The fixture event is a
// "delivered" line, which it sends to review without reading any chain.
const evidence = vi.hoisted(() => ({ verifyEvidence: vi.fn() }));

vi.mock("./db", () => db);
vi.mock("./counteraudit", () => ca);
vi.mock("./evidence", async importOriginal => {
  const actual = await importOriginal<typeof import("./evidence")>();
  evidence.verifyEvidence.mockImplementation(actual.verifyEvidence);
  return { ...actual, verifyEvidence: evidence.verifyEvidence };
});

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

// A passing Levy check, as server/evidence.ts returns it for the paid line in
// fixtures/arc-levy.
const TX = "0xd6fbaf6ec24b0ae502b0dd4e3360619eb9052652ecbaf51ae5566d86ad6aafe5";
const VERIFIED = {
  verifier: "levy-arc/1",
  status: "verified",
  reasons: [],
  charge: {
    kind: "charged",
    chain: "arc-testnet",
    chain_id: 5042002,
    tx_hash: TX,
    log_index: 14,
    block_number: "69882369",
    payer: "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77",
    recipient: "0x83F45b842c15c1417fDbCE296D966b1CE17544bD",
    amount: "1000000",
  },
  recipient_confirmed: true,
};

// The line the Bureau already holds for the fixture event.
const stored = {
  id: 7,
  packetId: packet.packet_id,
  signedEventHash: proof.outcome_claim.signed_event_hash,
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
      evidenceStatus: "needs_review",
      evidenceResult: {
        verifier: null,
        status: "needs_review",
        reasons: ["no machine check exists for delivered outcomes"],
      },
      evidenceCheckedAt: NOW,
      displayState: "unverified",
      dataClass: "test",
    });
    // A line with no charge claims none.
    expect(row).not.toHaveProperty("evidenceKey");
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
    expect(printed()).toContain(
      "evidence needs review: no machine check exists for delivered outcomes"
    );
    expect(printed()).toContain("Evidence: 0 verified, 1 to review");
    expect(printed()).not.toContain(INGEST_KEY);
    expect(printed()).not.toContain(DB_PASSWORD);
  });

  it("stores a verified charge with its settlement key, and the line stays unverified", async () => {
    ca.ingestSignedEvent.mockResolvedValue({ kind: "sealed", status: 201, packet });
    db.findOutcomeEvent.mockResolvedValue(undefined);
    evidence.verifyEvidence.mockResolvedValueOnce(VERIFIED);
    const { io, printed } = fakeIO();

    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(0);
    expect(evidence.verifyEvidence).toHaveBeenCalledWith(event);
    expect(db.findOtherOutcomeEventWithEvidence).toHaveBeenCalledWith(
      `5042002:${TX}:14`,
      "fur_e2etest01",
      "e2e-20261030185449"
    );
    const row = db.insertOutcomeEvent.mock.calls[0][0];
    expect(row).toMatchObject({
      evidenceStatus: "verified",
      evidenceResult: VERIFIED,
      evidenceKey: `5042002:${TX}:14`,
      displayState: "unverified",
    });
    expect(printed()).toContain(`evidence verified (arc-testnet tx ${TX}, log 14)`);
  });

  it("sends a line to review when another stored line already holds its charge", async () => {
    ca.ingestSignedEvent.mockResolvedValue({ kind: "sealed", status: 201, packet });
    db.findOutcomeEvent.mockResolvedValue(undefined);
    db.findOtherOutcomeEventWithEvidence.mockResolvedValue({
      furnisherId: "fur_other01",
      eventId: "charge-8-1",
    });
    evidence.verifyEvidence.mockResolvedValueOnce(VERIFIED);
    const { io, printed } = fakeIO();

    await runIntake(["--test-data", "events.jsonl"], io);
    const row = db.insertOutcomeEvent.mock.calls[0][0];
    expect(row.evidenceStatus).toBe("needs_review");
    expect(row.evidenceKey).toBe(`5042002:${TX}:14`);
    expect(row.evidenceResult.reasons).toEqual([
      "the same charge already backs fur_other01/charge-8-1",
    ]);
    expect(printed()).toContain("Evidence: 0 verified, 1 to review");
  });

  it.each([
    [
      "its merchant is not the furnisher's",
      () =>
        evidence.verifyEvidence.mockResolvedValueOnce({
          ...VERIFIED,
          status: "failed",
          recipient_confirmed: false,
        }),
    ],
    [
      "its proof failed",
      () => {
        vi.stubEnv("COUNTERAUDIT_ORG_ID", "00000000-0000-4000-8000-000000000000");
        evidence.verifyEvidence.mockResolvedValueOnce(VERIFIED);
      },
    ],
  ])("lets no line claim a charge when %s, so it cannot block the line that can", async (_name, arrange) => {
    ca.ingestSignedEvent.mockResolvedValue({ kind: "sealed", status: 201, packet });
    db.findOutcomeEvent.mockResolvedValue(undefined);
    arrange();
    const { io } = fakeIO();

    await runIntake(["--test-data", "events.jsonl"], io);
    expect(db.findOtherOutcomeEventWithEvidence).not.toHaveBeenCalled();
    const row = db.insertOutcomeEvent.mock.calls[0][0];
    expect(row).not.toHaveProperty("evidenceKey");
    expect(row.evidenceResult.charge.tx_hash).toBe(TX);
  });

  it("never clears a stored claim when a later check finds no charge", async () => {
    ca.ingestSignedEvent.mockResolvedValue({ kind: "already_sealed", status: 200, packet });
    db.findOutcomeEvent.mockResolvedValue(stored);
    evidence.verifyEvidence.mockResolvedValueOnce({
      verifier: "levy-arc/1",
      status: "failed",
      reasons: [`transaction ${TX} reverted`],
    });
    const { io } = fakeIO();

    await runIntake(["--test-data", "events.jsonl"], io);
    const [, update] = db.updateOutcomeEventEvidence.mock.calls[0];
    expect(update.evidenceStatus).toBe("failed");
    expect(update).not.toHaveProperty("evidenceKey");
  });

  it("updates nothing when the stored line holds a different event under the same packet", async () => {
    ca.ingestSignedEvent.mockResolvedValue({ kind: "already_sealed", status: 200, packet });
    db.findOutcomeEvent.mockResolvedValue({ ...stored, signedEventHash: "0".repeat(64) });
    const { io, printed } = fakeIO();

    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(1);
    expect(db.updateOutcomeEventProof).not.toHaveBeenCalled();
    expect(db.updateOutcomeEventEvidence).not.toHaveBeenCalled();
    expect(printed()).toContain(
      "not updated: the stored line holds a different signed event under this packet"
    );
  });

  it("keeps a stored line's evidence when a resubmission's check reaches no result", async () => {
    ca.ingestSignedEvent.mockResolvedValue({ kind: "already_sealed", status: 200, packet });
    db.findOutcomeEvent.mockResolvedValue(stored);
    evidence.verifyEvidence.mockResolvedValueOnce({
      verifier: "levy-arc/1",
      status: "error",
      reasons: ["chain read failed: fetch failed"],
    });
    const { io, printed } = fakeIO();

    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(0);
    expect(db.updateOutcomeEventProof).toHaveBeenCalledTimes(1);
    expect(db.updateOutcomeEventEvidence).not.toHaveBeenCalled();
    expect(printed()).toContain("already stored; proof check updated");
    expect(printed()).toContain("evidence not checked: chain read failed: fetch failed");
    expect(printed()).toContain("0 failed, 1 not checked yet");
  });

  it("treats a 200 as idempotent: the stored line keeps everything but its proof check", async () => {
    ca.ingestSignedEvent.mockResolvedValue({
      kind: "already_sealed",
      status: 200,
      packet,
    });
    db.findOutcomeEvent.mockResolvedValue(stored);
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
    expect(db.updateOutcomeEventEvidence).toHaveBeenCalledWith(7, {
      evidenceStatus: "needs_review",
      evidenceResult: expect.objectContaining({ status: "needs_review" }),
      evidenceCheckedAt: NOW,
    });
    expect(printed()).toContain("already sealed (200)");
    expect(printed()).toContain("already stored; proof and evidence checks updated");
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
    db.findOutcomeEvent.mockResolvedValue(stored);
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

  describe("relations between a furnisher's lines", () => {
    // Stored lines, kept in memory so settling one updates what the next
    // lookup sees. The fixture event is stored as "e2e-20261030185449".
    type Row = {
      id: number;
      furnisherId: string;
      eventId: string;
      subjectRef: Record<string, unknown>;
      dataClass: "test" | "live";
      proofOk: boolean;
      evidenceStatus: string | null;
      displayState: string;
      relationType: string | null;
      relationTargetEventId: string | null;
    };
    const OWN = "e2e-20261030185449";
    let rows: Row[];
    let nextId: number;

    function row(eventId: string, overrides: Partial<Row> = {}): Row {
      return {
        id: nextId++,
        furnisherId: "fur_e2etest01",
        eventId,
        subjectRef: event.subject_ref,
        dataClass: "test",
        proofOk: true,
        evidenceStatus: "needs_review",
        displayState: "unverified",
        relationType: null,
        relationTargetEventId: null,
        ...overrides,
      };
    }
    const byId = (eventId: string) => rows.find(r => r.eventId === eventId);

    beforeEach(() => {
      rows = [];
      nextId = 1;
      ca.ingestSignedEvent.mockResolvedValue({ kind: "sealed", status: 201, packet });
      db.findOutcomeEvent.mockResolvedValue(undefined);
      db.listReviewsForLine.mockResolvedValue([]);
      db.getOutcomeLine.mockImplementation(async (_f: string, eventId: string) => {
        const found = byId(eventId);
        return found && { ...found };
      });
      db.findRelatingOutcomeLines.mockImplementation(async (_f: string, eventId: string) =>
        rows.filter(r => r.relationTargetEventId === eventId).map(r => ({ ...r }))
      );
      db.setOutcomeEventDisplayState.mockImplementation(async (id: number, state: string) => {
        rows.find(r => r.id === id)!.displayState = state;
      });
    });

    it("applies a signed withdrawal to the furnisher's earlier line", async () => {
      rows.push(
        row("e2e-original"),
        row(OWN, { relationType: "withdraws", relationTargetEventId: "e2e-original" })
      );
      const { io, printed } = fakeIO();

      expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(0);
      expect(byId("e2e-original")!.displayState).toBe("withdrawn");
      expect(printed()).toContain(
        "withdraws e2e-original: applied; that line is now withdrawn"
      );
    });

    it("waits for a target that is not stored yet", async () => {
      rows.push(row(OWN, { relationType: "withdraws", relationTargetEventId: "e2e-original" }));
      const { io, printed } = fakeIO();

      await runIntake(["--test-data", "events.jsonl"], io);
      expect(db.setOutcomeEventDisplayState).not.toHaveBeenCalled();
      expect(printed()).toContain(
        "withdraws e2e-original: fur_e2etest01 has no such line yet; it takes effect when that line is stored"
      );
    });

    it("does not apply a relation whose own proof has not passed", async () => {
      rows.push(
        row("e2e-original"),
        row(OWN, {
          proofOk: false,
          relationType: "withdraws",
          relationTargetEventId: "e2e-original",
        })
      );
      const { io, printed } = fakeIO();

      await runIntake(["--test-data", "events.jsonl"], io);
      expect(byId("e2e-original")!.displayState).toBe("unverified");
      expect(printed()).toContain(
        "withdraws e2e-original: not applied, its own proof has not passed"
      );
    });

    it("restores a target when a relation that applied no longer does", async () => {
      rows.push(
        row("e2e-original", { displayState: "withdrawn" }),
        row(OWN, {
          proofOk: false,
          relationType: "withdraws",
          relationTargetEventId: "e2e-original",
        })
      );
      const { io, printed } = fakeIO();

      await runIntake(["--test-data", "events.jsonl"], io);
      expect(byId("e2e-original")!.displayState).toBe("unverified");
      expect(printed()).toContain(
        "withdraws e2e-original: not applied, its own proof has not passed; that line is now unverified"
      );
    });

    it("settles a line stored after the line that withdraws it", async () => {
      rows.push(
        row(OWN),
        row("e2e-later", { relationType: "withdraws", relationTargetEventId: OWN })
      );
      const { io, printed } = fakeIO();

      await runIntake(["--test-data", "events.jsonl"], io);
      expect(byId(OWN)!.displayState).toBe("withdrawn");
      expect(printed()).toContain("now shown as withdrawn");
    });

    it("ends a dispute the furnisher withdraws, along the chain", async () => {
      rows.push(
        row("e2e-a", { displayState: "disputed" }),
        row("e2e-b", { relationType: "disputes", relationTargetEventId: "e2e-a" }),
        row(OWN, { relationType: "withdraws", relationTargetEventId: "e2e-b" })
      );
      const { io, printed } = fakeIO();

      await runIntake(["--test-data", "events.jsonl"], io);
      expect(byId("e2e-b")!.displayState).toBe("withdrawn");
      expect(byId("e2e-a")!.displayState).toBe("unverified");
      expect(printed()).toContain(
        "disputes e2e-a by e2e-b: that line is now unverified"
      );
    });

    it("keeps a correction in force when the furnisher withdraws it", async () => {
      rows.push(
        row("e2e-a", { displayState: "superseded" }),
        row("e2e-b", { relationType: "corrects", relationTargetEventId: "e2e-a" }),
        row(OWN, { relationType: "withdraws", relationTargetEventId: "e2e-b" })
      );
      const { io } = fakeIO();

      await runIntake(["--test-data", "events.jsonl"], io);
      expect(byId("e2e-b")!.displayState).toBe("withdrawn");
      expect(byId("e2e-a")!.displayState).toBe("superseded");
    });

    it("exits 1 when a display state cannot be settled", async () => {
      db.getOutcomeLine.mockRejectedValue(new Error("connection lost"));
      const { io, printed } = fakeIO();

      expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(1);
      expect(printed()).toContain(
        "display state not settled (connection lost); run again to settle it"
      );
    });
  });

  it("does not send a line that is not a signed v1 event", async () => {
    const { io, printed } = fakeIO('{"furnisher_id": "fur_x"}\nnot json\n');
    expect(await runIntake(["--test-data", "events.jsonl"], io)).toBe(1);
    expect(ca.ingestSignedEvent).not.toHaveBeenCalled();
    expect(printed()).toContain("line 1: not sent");
    expect(printed()).toContain("line 2: not sent: not valid JSON");
  });
});
