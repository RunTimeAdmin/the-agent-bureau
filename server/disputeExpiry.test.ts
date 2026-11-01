// pnpm lines expire and subject disputes: erasing a line also erases what its dispute records
// say about the subject, keeping where each was sealed and what its checks found.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

const db = vi.hoisted(() => ({
  schemaReady: vi.fn(async () => true),
  listExpiryLines: vi.fn(async () => [] as unknown[]),
  eraseOutcomeEventContent: vi.fn(async () => true),
  eraseDisputeRecordContent: vi.fn(async () => 1),
}));
vi.mock("./db", () => db);

import type { ProofResult } from "./counteraudit";
import {
  DISPUTE_SCHEMA,
  checkStoredRecord,
  signWithWallet,
  walletAddress,
  type StoredDisputeRecord,
} from "./dispute";
import {
  erasedDisputeColumns,
  runLines,
  type ExpiryLine,
  type LinesIO,
} from "./lineExpiry";
import { canonicalizeJson } from "./outcomeProof";

const NOW = new Date("2028-11-01T04:00:00.000Z");
const BUREAU_ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
const SUBJECT_KEY = generatePrivateKey();
const SUBJECT = walletAddress(SUBJECT_KEY);

const exportKeys = generateKeyPairSync("ed25519");
const JWKS = {
  keys: [
    { ...exportKeys.publicKey.export({ format: "jwk" }), kid: "test-export-1" },
  ],
};
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest();
function signExport(payload: Record<string, unknown>) {
  const options = {
    type: "DataIntegrityProof",
    cryptosuite: "eddsa-jcs-2022",
    created: "2026-10-31T00:00:00.000Z",
    verificationMethod:
      "/.well-known/counteraudit-export-jwk.json#test-export-1",
    proofPurpose: "assertionMethod",
  };
  const data = Buffer.concat([
    sha256(canonicalizeJson(options)),
    sha256(canonicalizeJson(payload)),
  ]);
  return {
    ...payload,
    signature: {
      algorithm: "eddsa-jcs-2022",
      digest: sha256(canonicalizeJson(payload)).toString("hex"),
      signature: `z${bs58.encode(sign(null, data, exportKeys.privateKey))}`,
      key_id: "test-export-1",
      proof: options,
    },
  };
}

let nextId = 1;
async function disputedLine(
  overrides: Partial<ExpiryLine> = {}
): Promise<ExpiryLine> {
  const id = nextId++;
  const record = await signWithWallet(
    {
      schema: DISPUTE_SCHEMA,
      kind: "dispute",
      dispute_id: `6d1f2a3b-4c5d-4e6f-8a7b-${String(id).padStart(12, "0")}`,
      line: {
        furnisher_id: "fur_bureaupilot01",
        event_id: `event-${id}`,
        signed_event_hash: "ab".repeat(32),
      },
      subject_ref: { wallet: SUBJECT },
      signer: { type: "eip191", address: SUBJECT },
      reason: "I never received this.",
      filed_at: "2026-11-01T10:00:00.000Z",
    },
    SUBJECT_KEY
  );
  const dispute: StoredDisputeRecord = {
    id: 100 + id,
    disputeId: String(record.dispute_id),
    kind: "dispute",
    record,
    packetId: `11111111-0000-4000-8000-${String(id).padStart(12, "0")}`,
    sequence: 40 + id,
    sealedAt: new Date("2026-11-01T10:00:01.000Z"),
    signatureOk: true,
    subjectControlOk: true,
    checkProblem: null,
    controllerAddress: null,
  };
  return {
    id,
    furnisherId: "fur_bureaupilot01",
    eventId: `event-${id}`,
    subjectRef: { wallet: SUBJECT },
    dataClass: "test",
    proofOk: true,
    evidenceStatus: "verified",
    evidenceResult: { status: "verified", reasons: [] },
    evidenceKey: null,
    signedEventHash: "ab".repeat(32),
    displayState: "disputed",
    relationType: null,
    relationTargetEventId: null,
    outcome: "delivered",
    caCreatedAt: new Date("2026-10-31T11:00:01.000Z"),
    packetId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    entryHash: createHash("sha256").update(`packet ${id}`).digest("hex"),
    sequence: id,
    expiredAt: null,
    disputeRecords: [dispute],
    ...overrides,
  };
}

const erasedSource = (l: ExpiryLine): ProofResult => ({
  ok: false,
  status: 410,
  message: "CounterAudit erased this packet under its retention policy",
  tombstone: signExport({
    tombstone_type: "counteraudit.packet_tombstone",
    tombstone_version: 1,
    org_id: BUREAU_ORG,
    packet_id: l.packetId,
    sequence: l.sequence,
    entry_hash: l.entryHash,
    expired_at: "2028-10-31T03:15:00.000Z",
    commitment: "linkage_only",
  }),
});

function linesIO(answers: Record<string, ProofResult>) {
  const out: string[] = [];
  const io: LinesIO = {
    log: l => out.push(l),
    now: () => NOW,
    fetchProof: vi.fn(
      async (packetId: string) =>
        answers[packetId] ?? {
          ok: false as const,
          status: 404,
          message: "not_found",
        }
    ),
    jwks: JWKS,
    furnishers: {},
  };
  return { io, printed: () => out.join("\n") };
}

beforeEach(() => {
  db.eraseOutcomeEventContent.mockClear();
  db.eraseDisputeRecordContent.mockClear();
  process.env.DATABASE_URL = "mysql://test";
  process.env.COUNTERAUDIT_ORG_ID = BUREAU_ORG;
});

describe("pnpm lines expire and subject disputes", () => {
  it("erases the dispute records' content with the line, keeping where each was sealed and its check result", async () => {
    const line = await disputedLine();
    db.listExpiryLines.mockResolvedValue([line]);
    const { io, printed } = linesIO({ [line.packetId]: erasedSource(line) });
    expect(await runLines(["expire"], io)).toBe(0);
    expect(db.eraseOutcomeEventContent).toHaveBeenCalledTimes(1);
    expect(db.eraseDisputeRecordContent).toHaveBeenCalledWith(
      line.id,
      erasedDisputeColumns()
    );
    expect(printed()).toContain(
      `fur_bureaupilot01/${line.eventId} (packet ${line.packetId}): 1 dispute record erased with it`
    );

    const [row] = line.disputeRecords!;
    const erased = {
      ...row,
      receipt: { receipt_type: "x" },
      ...erasedDisputeColumns(),
    };
    expect(erased).toEqual({
      id: row.id,
      disputeId: row.disputeId,
      kind: "dispute",
      record: null,
      packetId: row.packetId,
      sequence: row.sequence,
      sealedAt: row.sealedAt,
      receipt: null,
      signatureOk: true,
      subjectControlOk: true,
      checkProblem: null,
      controllerAddress: null,
    });
    // An erased record counts for nothing.
    expect(
      await checkStoredRecord(
        erased,
        {
          furnisherId: line.furnisherId,
          subjectRef: null,
          signedEvent: null,
          receipt: null,
        },
        {}
      )
    ).toMatchObject({
      ok: false,
      problem: "the record was erased with the line's source",
    });
  });

  it("says what it would erase on a dry run, and erases nothing", async () => {
    const line = await disputedLine();
    db.listExpiryLines.mockResolvedValue([line]);
    const { io, printed } = linesIO({ [line.packetId]: erasedSource(line) });
    expect(await runLines(["expire", "--dry-run"], io)).toBe(0);
    expect(db.eraseDisputeRecordContent).not.toHaveBeenCalled();
    expect(printed()).toContain("its dispute records would be erased with it");
  });

  it("erases what an earlier run left, and leaves a line whose source stands alone", async () => {
    const leftOver = await disputedLine({
      expiredAt: new Date("2028-10-31T04:00:00.000Z"),
    });
    const standing = await disputedLine();
    db.listExpiryLines.mockResolvedValue([leftOver, standing]);
    const { io } = linesIO({
      [standing.packetId]: {
        ok: true,
        proof: signExport({
          proof_type: "counteraudit.packet_proof",
          proof_version: 1,
          packet_id: standing.packetId,
          org_id: BUREAU_ORG,
          sequence: standing.sequence,
          entry_hash: standing.entryHash,
          expires_at: "2029-10-31T11:00:01.000Z",
        }),
      },
    });
    expect(await runLines(["expire"], io)).toBe(0);
    expect(db.eraseDisputeRecordContent).toHaveBeenCalledTimes(1);
    expect(db.eraseDisputeRecordContent).toHaveBeenCalledWith(
      leftOver.id,
      erasedDisputeColumns()
    );
    expect(db.eraseOutcomeEventContent).not.toHaveBeenCalled();
  });
});
