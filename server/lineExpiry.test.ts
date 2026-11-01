// pnpm lines expire: a line's content is erased once CounterAudit has erased
// its source, or the source's retention date has passed, and never on anything
// less than CounterAudit's signed word for it.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  schemaReady: vi.fn(async () => true),
  listExpiryLines: vi.fn(async () => [] as unknown[]),
  eraseOutcomeEventContent: vi.fn(async () => true),
}));
vi.mock("./db", () => db);

import type { ProofResult } from "./counteraudit";
import {
  erasedColumns,
  runLines,
  type ExpiryLine,
  type LinesIO,
} from "./lineExpiry";
import { canonicalizeJson } from "./outcomeProof";

const NOW = new Date("2028-11-01T04:00:00.000Z");
const BUREAU_ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
const WALLET = "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77";

const exportKeys = generateKeyPairSync("ed25519");
const JWKS = {
  keys: [
    { ...exportKeys.publicKey.export({ format: "jwk" }), kid: "test-export-1" },
  ],
};
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest();
function signExport(
  payload: Record<string, unknown>,
  key = exportKeys.privateKey
) {
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
      signature: `z${bs58.encode(sign(null, data, key))}`,
      key_id: "test-export-1",
      proof: options,
    },
  };
}

let nextId = 1;
function line(overrides: Partial<ExpiryLine> = {}): ExpiryLine {
  const id = nextId++;
  return {
    id,
    furnisherId: "fur_bureaupilot01",
    eventId: `event-${id}`,
    subjectRef: { wallet: WALLET },
    dataClass: "test",
    proofOk: true,
    evidenceStatus: "verified",
    evidenceResult: { status: "verified", reasons: [] },
    evidenceKey: `5042002:0x${String(id).padStart(64, "0")}:1`,
    signedEventHash: createHash("sha256").update(`event ${id}`).digest("hex"),
    displayState: "released",
    relationType: null,
    relationTargetEventId: null,
    outcome: "delivered",
    caCreatedAt: new Date("2026-10-31T11:00:01.000Z"),
    packetId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    entryHash: createHash("sha256").update(`packet ${id}`).digest("hex"),
    sequence: id,
    expiredAt: null,
    ...overrides,
  };
}

const proofOf = (l: ExpiryLine, changes: Record<string, unknown> = {}) =>
  signExport({
    proof_type: "counteraudit.packet_proof",
    proof_version: 1,
    packet_id: l.packetId,
    org_id: BUREAU_ORG,
    sequence: l.sequence,
    entry_hash: l.entryHash,
    connector_id: "agent-bureau-outcome-v1",
    created_at: new Date(l.caCreatedAt).toISOString(),
    public_proof: true,
    content_verified: true,
    outcome_claim: {
      outcome: l.outcome,
      asserted_by: "signature",
      signer: {
        furnisher_id: l.furnisherId,
        key_id: "pilot-2026-10",
        public_key: "ed25519:test",
      },
      signed_event_hash: l.signedEventHash,
    },
    ...changes,
  });
const ERASED_AT = "2028-10-31T03:15:00.000Z";
const tombstoneOf = (
  l: ExpiryLine,
  changes: Record<string, unknown> = {},
  key = exportKeys.privateKey
) =>
  signExport(
    {
      tombstone_type: "counteraudit.packet_tombstone",
      tombstone_version: 1,
      org_id: BUREAU_ORG,
      packet_id: l.packetId,
      sequence: l.sequence,
      entry_hash: l.entryHash,
      expired_at: ERASED_AT,
      commitment: "linkage_only",
      ...changes,
    },
    key
  );

// What CounterAudit's proof route answers, by packet id.
let answers: Record<string, ProofResult> = {};
const current = (
  l: ExpiryLine,
  changes: Record<string, unknown> = {}
): ProofResult => ({
  ok: true,
  proof: proofOf(l, changes),
});
const gone = (tombstone: Record<string, unknown>): ProofResult => ({
  ok: false,
  status: 410,
  message: "CounterAudit erased this packet under its retention policy",
  tombstone,
});

function linesIO() {
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
  return { io, out, printed: () => out.join("\n") };
}

function holding(...rows: ExpiryLine[]) {
  db.listExpiryLines.mockResolvedValue(rows);
}

beforeEach(() => {
  answers = {};
  db.eraseOutcomeEventContent.mockClear();
  db.eraseOutcomeEventContent.mockResolvedValue(true);
  db.schemaReady.mockResolvedValue(true);
  vi.stubEnv("DATABASE_URL", "mysql://test");
  vi.stubEnv("COUNTERAUDIT_ORG_ID", BUREAU_ORG);
});

const erasedIds = () =>
  db.eraseOutcomeEventContent.mock.calls.map(call => (call as unknown[])[0]);

describe("pnpm lines expire", () => {
  it("erases a line whose source CounterAudit erased or which passed its retention date, and keeps the rest", async () => {
    const erased = line();
    const due = line();
    const later = line();
    const undated = line();
    const before = line({
      expiredAt: new Date("2028-10-01T00:00:00.000Z"),
      subjectRef: null,
    });
    holding(erased, due, later, undated, before);
    answers[erased.packetId] = gone(tombstoneOf(erased));
    answers[due.packetId] = current(due, {
      expires_at: "2028-10-31T11:00:01.000Z",
    });
    answers[later.packetId] = current(later, {
      expires_at: "2028-12-31T11:00:01.000Z",
    });
    answers[undated.packetId] = current(undated);
    const { io, printed } = linesIO();

    expect(await runLines(["expire"], io)).toBe(0);
    expect(erasedIds()).toEqual([erased.id, due.id]);
    expect(db.eraseOutcomeEventContent.mock.calls[0]).toEqual([
      erased.id,
      erasedColumns(NOW, `CounterAudit erased it at ${ERASED_AT}`),
    ]);
    expect(io.fetchProof).not.toHaveBeenCalledWith(before.packetId);
    expect(printed()).toContain(
      `fur_bureaupilot01/${due.eventId} (packet ${due.packetId}): erased: it reached its retention date, 2028-10-31T11:00:01.000Z`
    );
    expect(printed()).toContain(
      "4 lines checked (1 expired before): 2 erased, 0 held, 0 not checked."
    );
  });

  it("keeps nothing about the subject", () => {
    const columns = erasedColumns(NOW, "why");
    for (const name of [
      "subjectRef",
      "signedEvent",
      "evidenceResult",
      "evidenceKey",
      "receipt",
    ] as const) {
      expect(columns[name]).toBeNull();
    }
    expect(columns).toMatchObject({
      proofOk: false,
      displayState: "unverified",
      expiredAt: NOW,
    });
    expect(columns.proofChecks).toEqual({
      source_expired: { ok: false, detail: "why" },
    });
  });

  it("erases nothing on a dry run", async () => {
    const erased = line();
    holding(erased);
    answers[erased.packetId] = gone(tombstoneOf(erased));
    const { io, printed } = linesIO();
    expect(await runLines(["expire", "--dry-run"], io)).toBe(0);
    expect(db.eraseOutcomeEventContent).not.toHaveBeenCalled();
    expect(printed()).toContain("1 would be erased");
  });

  it("reads the date from a proof whose content no longer checks, but only CounterAudit's for that packet", async () => {
    const changed = line();
    const forged = line();
    holding(changed, forged);
    // The event hash no longer matches: the packet is still the one the line names.
    answers[changed.packetId] = current(changed, {
      expires_at: "2028-10-31T11:00:01.000Z",
      outcome_claim: {
        asserted_by: "signature",
        outcome: "delivered",
        signed_event_hash: "f".repeat(64),
      },
    });
    answers[forged.packetId] = {
      ok: true,
      proof: signExport(
        {
          ...proofOf(forged),
          signature: undefined,
          expires_at: "2028-10-31T11:00:01.000Z",
        },
        generateKeyPairSync("ed25519").privateKey
      ),
    };
    const { io, printed } = linesIO();
    expect(await runLines(["expire"], io)).toBe(1);
    expect(erasedIds()).toEqual([changed.id]);
    expect(printed()).toContain(
      `${forged.eventId} (packet ${forged.packetId}): not checked: its proof is not CounterAudit's for this packet: proof_signature`
    );
  });

  it("leaves a line it cannot check, and exits 1", async () => {
    const unreadable = line();
    const misplaced = line();
    const undatable = line();
    const unsigned = line();
    holding(unreadable, misplaced, undatable, unsigned);
    answers[unreadable.packetId] = {
      ok: false,
      status: 503,
      message: "proof_unavailable",
    };
    answers[misplaced.packetId] = gone(
      tombstoneOf(misplaced, { sequence: 999 })
    );
    answers[undatable.packetId] = current(undatable, { expires_at: "soon" });
    answers[unsigned.packetId] = gone(
      tombstoneOf(unsigned, {}, generateKeyPairSync("ed25519").privateKey)
    );
    const { io, printed } = linesIO();
    expect(await runLines(["expire"], io)).toBe(1);
    expect(db.eraseOutcomeEventContent).not.toHaveBeenCalled();
    expect(printed()).toContain(
      "its proof could not be read: proof_unavailable"
    );
    expect(printed()).toContain(
      "CounterAudit's record of erasing it does not check: sequence"
    );
    expect(printed()).toContain("its proof's expires_at is not a time");
    expect(printed()).toContain(
      "4 lines checked (0 expired before): 0 erased, 0 held, 4 not checked."
    );
  });

  it("holds a withdrawal whose target still stands, and erases both once the target is due", async () => {
    const target = line({ displayState: "withdrawn" });
    const withdrawal = line({
      relationType: "withdraws",
      relationTargetEventId: target.eventId,
    });
    holding(target, withdrawal);
    answers[target.packetId] = current(target, {
      expires_at: "2028-12-31T11:00:01.000Z",
    });
    answers[withdrawal.packetId] = gone(tombstoneOf(withdrawal));
    const first = linesIO();
    expect(await runLines(["expire"], first.io)).toBe(1);
    expect(db.eraseOutcomeEventContent).not.toHaveBeenCalled();
    expect(first.printed()).toContain(
      `held: CounterAudit erased it at ${ERASED_AT}, but it withdraws ${target.eventId}, whose source has not expired`
    );

    answers[target.packetId] = gone(tombstoneOf(target));
    const second = linesIO();
    expect(await runLines(["expire"], second.io)).toBe(0);
    expect(erasedIds()).toEqual([target.id, withdrawal.id]);
  });

  it("does not hold a line whose relation no longer acts", async () => {
    const target = line();
    const dispute = line({
      relationType: "disputes",
      relationTargetEventId: target.eventId,
      displayState: "withdrawn",
    });
    holding(target, dispute);
    answers[target.packetId] = current(target);
    answers[dispute.packetId] = gone(tombstoneOf(dispute));
    const { io } = linesIO();
    expect(await runLines(["expire"], io)).toBe(0);
    expect(erasedIds()).toEqual([dispute.id]);
  });

  it("asks for its command and settings", async () => {
    holding();
    expect(await runLines([], linesIO().io)).toBe(2);
    expect(await runLines(["expire", "--now"], linesIO().io)).toBe(2);
    vi.stubEnv("COUNTERAUDIT_ORG_ID", "");
    const { io, printed } = linesIO();
    expect(await runLines(["expire"], io)).toBe(2);
    expect(printed()).toContain("Not set: COUNTERAUDIT_ORG_ID");
  });
});
