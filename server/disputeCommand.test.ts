// pnpm dispute submit, sync, settle and sign, and the dispute lines of pnpm review queue, against
// the Bureau's lines, dispute records and review log in memory, with CounterAudit and Sigvara stood in.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

type Row = {
  id: number;
  furnisherId: string;
  eventId: string;
  outcome: string;
  subjectRef: Record<string, unknown> | null;
  dataClass: "test" | "live";
  proofOk: boolean;
  evidenceStatus: string | null;
  evidenceResult: Record<string, unknown> | null;
  evidenceKey: string | null;
  signedEventHash: string;
  displayState: string;
  relationType: string | null;
  relationTargetEventId: string | null;
  caCreatedAt: Date;
  signedEvent: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  expiredAt: Date | null;
};
type DisputeRow = Record<string, unknown> & {
  id: number;
  disputeId: string;
  outcomeEventId: number;
  packetId: string;
};
const store = vi.hoisted(() => ({
  rows: [] as Row[],
  disputes: [] as DisputeRow[],
  log: [] as { id: number; sequence: number; [k: string]: unknown }[],
}));
const withDisputes = (row: Row) => ({
  ...row,
  disputeRecords: store.disputes
    .filter(d => d.outcomeEventId === row.id)
    .map(d => ({ ...d })),
});
const db = vi.hoisted(() => ({
  schemaReady: vi.fn(async () => true),
  findDisputeLine: vi.fn(async (f: string, e: string) => {
    const row = store.rows.find(r => r.furnisherId === f && r.eventId === e);
    return row && withDisputes(row);
  }),
  getDisputeLine: vi.fn(async (id: number) => {
    const row = store.rows.find(r => r.id === id);
    return row && withDisputes(row);
  }),
  listOutcomeLines: vi.fn(async () => store.rows.map(withDisputes)),
  findRelatingOutcomeLines: vi.fn(async (f: string, e: string) =>
    store.rows
      .filter(r => r.furnisherId === f && r.relationTargetEventId === e)
      .map(r => ({ ...r }))
  ),
  listDisputeRecords: vi.fn(async (id: string) =>
    store.disputes.filter(d => d.disputeId === id).map(d => ({ ...d }))
  ),
  listStoredDisputes: vi.fn(async () =>
    store.disputes.map(d => {
      const line = store.rows.find(r => r.id === d.outcomeEventId);
      return {
        ...d,
        lineFurnisherId: line?.furnisherId ?? null,
        lineEventId: line?.eventId ?? null,
        lineSignedEventHash: line?.signedEventHash ?? null,
        lineExpiredAt: line?.expiredAt ?? null,
      };
    })
  ),
  insertDisputeRecord: vi.fn(async (row: Omit<DisputeRow, "id">) => {
    if (store.disputes.some(d => d.packetId === row.packetId)) return false;
    store.disputes.push({ ...row, id: store.disputes.length + 1 });
    return true;
  }),
  setOutcomeEventDisplayState: vi.fn(async (id: number, state: string) => {
    store.rows.find(r => r.id === id)!.displayState = state;
  }),
  listReviewLogRecords: vi.fn(async () =>
    [...store.log].sort((a, b) => a.sequence - b.sequence)
  ),
  getReviewLogSync: vi.fn(async () => undefined),
}));
// These fakes make up their packets' hashes; server/packetHash.test.ts runs the real check.
vi.mock("./packetHash", () => ({ packetHashProblem: () => null }));
vi.mock("./db", () => db);

const pin = vi.hoisted(() => ({ genesis: null as string | null }));
vi.mock("./reviewLog", async importOriginal => {
  const actual = await importOriginal<typeof import("./reviewLog")>();
  return {
    ...actual,
    get REVIEW_GENESIS() {
      return pin.genesis;
    },
    replayReviewLog: (records: Parameters<typeof actual.replayReviewLog>[0]) =>
      actual.replayReviewLog(records, pin.genesis),
  };
});

import type { DisputeIngestResult } from "./counteraudit";
import {
  DISPUTE_SCHEMA,
  signWithFurnisherKey,
  signWithWallet,
  walletAddress,
} from "./dispute";
import { runDispute, type DisputeIO } from "./disputeCommand";
import { runReview, type ReviewIO } from "./review";
import {
  REVIEW_SCHEMA,
  evidenceDigest,
  newReviewerKey,
  signReviewDecision,
} from "./reviewDecision";
import { REVIEWER_KEY_SCHEMA, genesisHash, signKeyRecord } from "./reviewLog";
import type { SigvaraClient } from "./sigvaraStanding";

// The Bureau organization's checkpoints in these fakes are signed with a key made for the test run
// (server/testCheckpoint.ts); the pinned keys gain it in this file only.
vi.mock("./counterauditKeys", async importOriginal => {
  const actual = await importOriginal<typeof import("./counterauditKeys")>();
  const { TEST_EXPORT_KEY } = await import("./testCheckpoint");
  return { COUNTERAUDIT_EXPORT_KEYS: { keys: [...actual.COUNTERAUDIT_EXPORT_KEYS.keys, TEST_EXPORT_KEY] } };
});
import { chainOf, checkpointResponse, erasureStatementOf } from "./testCheckpoint";

const T0 = new Date("2026-11-01T10:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const SUBJECT_KEY = generatePrivateKey();
const SUBJECT = walletAddress(SUBJECT_KEY);
const OTHER_KEY = generatePrivateKey();
const OTHER = walletAddress(OTHER_KEY);
const FURNISHER = "fur_levymerchant1";
const EVENT = "levy-sub8-charge1";
const HASH = "ab".repeat(32);
const EVIDENCE = { status: "verified", reasons: [] };
const furnisherKey = newReviewerKey();
const strangerKey = newReviewerKey();
const people = {
  alice: newReviewerKey(),
  bob: newReviewerKey(),
  carol: newReviewerKey(),
};
const TEAM = (["alice", "bob", "carol"] as const).map(p => ({
  reviewer_id: `rev_${p}`,
  name: p,
  public_key: people[p].publicKey,
}));
const idOf = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hashOf = (n: number) =>
  n < 0
    ? "0".repeat(64)
    : createHash("sha256").update(`packet ${n}`).digest("hex");
const DISPUTE_1 = "6d1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const DISPUTE_2 = "7e2f3a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";

function line(overrides: Partial<Row> = {}): Row {
  return {
    id: store.rows.length + 1,
    furnisherId: FURNISHER,
    eventId: EVENT,
    outcome: "paid",
    subjectRef: { wallet: SUBJECT },
    dataClass: "test",
    proofOk: true,
    evidenceStatus: "verified",
    evidenceResult: EVIDENCE,
    evidenceKey: null,
    signedEventHash: HASH,
    displayState: "released",
    relationType: null,
    relationTargetEventId: null,
    caCreatedAt: at(-10),
    signedEvent: {
      furnisher_id: FURNISHER,
      event_id: EVENT,
      key_id: "levy-key-1",
    },
    // CounterAudit's ingest receipt, built from the same fields as the public proof.
    receipt: {
      receipt_type: "counteraudit.packet_receipt",
      receipt_version: 1,
      packet_id: idOf(500),
      sequence: 500,
      outcome_claim: {
        outcome: "paid",
        asserted_by: "signature",
        event_id: EVENT,
        signed_event_hash: HASH,
        signer: {
          furnisher_id: FURNISHER,
          key_id: "levy-key-1",
          public_key: furnisherKey.publicKey,
        },
      },
    },
    expiredAt: null,
    ...overrides,
  };
}

// The review log: the genesis, and Alice approving the line (test data: one approval releases it).
function reviewLog(extra: Record<string, unknown>[] = []) {
  const genesis = (["alice", "bob", "carol"] as const).map(p =>
    signKeyRecord(
      {
        schema: REVIEWER_KEY_SCHEMA,
        signer_id: `rev_${p}`,
        change: { type: "genesis", reviewers: TEAM },
        decided_at: at(-5).toISOString(),
      },
      people[p].privateKeyPem
    )
  );
  const approval = signReviewDecision(
    {
      schema: REVIEW_SCHEMA,
      reviewer_id: "rev_alice",
      furnisher_id: FURNISHER,
      event_id: EVENT,
      signed_event_hash: HASH,
      data_class: "test",
      evidence_digest: evidenceDigest(EVIDENCE),
      decision: "approve",
      decided_at: at(-5).toISOString(),
    },
    people.alice.privateKeyPem
  );
  store.log = [...genesis, approval, ...extra].map((record, n) => ({
    id: n + 1,
    sequence: n,
    packetId: idOf(1000 + n),
    prevHash: hashOf(n - 1),
    entryHash: hashOf(n),
    connectorId: "agent-bureau-review-v1",
    sealedAt: at(-5),
    record,
    readAt: at(-5),
  }));
}

const filing = (
  overrides: Record<string, unknown> = {},
  key = SUBJECT_KEY,
  address = SUBJECT
) =>
  signWithWallet(
    {
      schema: DISPUTE_SCHEMA,
      kind: "dispute",
      dispute_id: DISPUTE_1,
      line: {
        furnisher_id: FURNISHER,
        event_id: EVENT,
        signed_event_hash: HASH,
      },
      subject_ref: { wallet: SUBJECT },
      signer: { type: "eip191", address },
      reason: "I never made this payment.",
      filed_at: T0.toISOString(),
      ...overrides,
    },
    key
  );
const confirm = (pem = furnisherKey.privateKeyPem) =>
  signWithFurnisherKey(
    {
      schema: DISPUTE_SCHEMA,
      kind: "response",
      dispute_id: DISPUTE_1,
      furnisher_id: FURNISHER,
      key_id: "levy-key-1",
      response: "confirm",
      evidence: [{ tx_hash: `0x${"cd".repeat(32)}` }],
      responded_at: at(2).toISOString(),
    },
    pem
  );
const statement = (text: string) =>
  signWithWallet(
    {
      schema: DISPUTE_SCHEMA,
      kind: "statement",
      dispute_id: DISPUTE_1,
      signer: { type: "eip191", address: SUBJECT },
      text,
      stated_at: at(3).toISOString(),
    },
    SUBJECT_KEY
  );
const appeal = (reason: string) =>
  signWithWallet(
    {
      schema: DISPUTE_SCHEMA,
      kind: "appeal",
      dispute_id: DISPUTE_1,
      party: "subject",
      signer: { type: "eip191", address: SUBJECT },
      reason,
      appealed_at: at(4).toISOString(),
    },
    SUBJECT_KEY
  );

const clock = { now: T0, sealed: 0 };
const chain = {
  agentAddress: SUBJECT as string,
};
function disputeIO() {
  const out: string[] = [];
  const files: Record<string, string> = {};
  const ingest = vi.fn(async (): Promise<DisputeIngestResult> => {
    clock.sealed++;
    return {
      kind: "sealed",
      packet: {
        packet_id: idOf(clock.sealed),
        entry_hash: hashOf(clock.sealed),
        sequence: clock.sealed,
        created_at: clock.now.toISOString(),
        raw_event_hash: "f".repeat(64),
        receipt: { receipt_type: "counteraudit.packet_receipt" },
      },
    };
  });
  const sigvara = {
    chainId: async () => 5042002,
    finalizedBlock: async () => ({
      number: 77n,
      hash: `0x${"11".repeat(32)}`,
      timestamp: 1_793_000_000n,
    }),
    identity: async () => ({
      agentAddress: chain.agentAddress,
      status: 0,
      registeredAt: 1n,
    }),
  } as unknown as SigvaraClient;
  const io: DisputeIO = {
    readText: async p => {
      if (!(p in files)) throw new Error("no such file");
      return files[p];
    },
    writeNewFile: async (p, text) => {
      if (p in files) throw new Error("exists");
      files[p] = text;
    },
    log: line => out.push(line),
    now: () => clock.now,
    ingest,
    sigvara,
    furnishers: {},
  };
  return { io, out, files, ingest };
}

// Submits one record as the operator would, sealed at `sealedAt`.
async function submit(record: Record<string, unknown>, sealedAt: Date) {
  clock.now = sealedAt;
  const f = disputeIO();
  f.files["record.json"] = JSON.stringify(record);
  const code = await runDispute(["submit", "record.json"], f.io);
  return { code, printed: f.out.join("\n"), ingest: f.ingest };
}

beforeEach(() => {
  store.rows = [];
  store.rows = [line()];
  store.disputes = [];
  pin.genesis = genesisHash(TEAM);
  reviewLog();
  clock.now = T0;
  clock.sealed = 0;
  chain.agentAddress = SUBJECT;
  process.env.DATABASE_URL = "mysql://test";
  process.env.COUNTERAUDIT_ORG_ID = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
  process.env.COUNTERAUDIT_INGEST_KEY = "ca_ingest_test";
  process.env.COUNTERAUDIT_READ_KEY = "ca_read_test";
});

describe("pnpm dispute submit", () => {
  it("seals a checked dispute, stores it and shows the line disputed with the furnisher's deadline", async () => {
    const record = await filing();
    const { code, printed, ingest } = await submit(record, T0);
    expect(code).toBe(0);
    expect(ingest).toHaveBeenCalledWith(record);
    expect(store.disputes).toHaveLength(1);
    expect(store.disputes[0]).toMatchObject({
      disputeId: DISPUTE_1,
      kind: "dispute",
      outcomeEventId: 1,
      packetId: idOf(1),
      sequence: 1,
      sealedAt: T0,
      signatureOk: true,
      subjectControlOk: true,
      checkProblem: null,
      controllerAddress: null,
    });
    expect(store.rows[0].displayState).toBe("disputed");
    expect(printed).toContain(
      `Sealed in CounterAudit as packet ${idOf(1)}, sequence 1, at ${T0.toISOString()}; stored.`
    );
    expect(printed).toContain(
      `Dispute ${DISPUTE_1} is open: the furnisher must answer by ${at(15).toISOString()}.`
    );
    expect(printed).toContain(
      `${FURNISHER}/${EVENT} is now shown as disputed.`
    );
  });

  it("refuses a second open dispute on a line, sending nothing", async () => {
    expect((await submit(await filing(), T0)).code).toBe(0);
    const second = await submit(await filing({ dispute_id: DISPUTE_2 }), at(1));
    expect(second.code).toBe(2);
    expect(second.ingest).not.toHaveBeenCalled();
    expect(second.printed).toContain(
      `already carries open dispute ${DISPUTE_1}; the furnisher must answer by ${at(15).toISOString()}`
    );
    expect(store.disputes).toHaveLength(1);
  });

  it("seals and stores a record whose signature fails, and counts it for nothing", async () => {
    // Signed by another wallet, while naming the subject's.
    const forged = await filing({}, OTHER_KEY);
    const { code, printed, ingest } = await submit(forged, T0);
    expect(code).toBe(1);
    expect(ingest).toHaveBeenCalled();
    expect(store.disputes[0]).toMatchObject({
      signatureOk: false,
      checkProblem: `the signature does not verify as ${SUBJECT}'s`,
    });
    expect(printed).toContain(
      "It counts for nothing: the signature does not verify"
    );
    expect(store.rows[0].displayState).toBe("released");
  });

  it("counts for nothing a dispute signed by a wallet that is not the line's", async () => {
    const { code, printed } = await submit(
      await filing({}, OTHER_KEY, OTHER),
      T0
    );
    expect(code).toBe(1);
    expect(store.disputes[0]).toMatchObject({
      signatureOk: true,
      subjectControlOk: false,
    });
    expect(printed).toContain(
      `signed by ${OTHER}, not the wallet the line names (${SUBJECT})`
    );
    expect(store.rows[0].displayState).toBe("released");
  });

  it("checks a did:sigvara subject against SigvaraIdentity's agent address and stores it", async () => {
    const did = { did: `did:sigvara:5042002:${SUBJECT.toLowerCase()}` };
    store.rows = [line({ subjectRef: did })];
    const { code, printed } = await submit(
      await filing({ subject_ref: did }),
      T0
    );
    expect(code).toBe(0);
    expect(store.disputes[0]).toMatchObject({
      subjectControlOk: true,
      controllerAddress: SUBJECT,
    });
    expect(printed).toContain(`SigvaraIdentity's agent address ${SUBJECT}`);
    expect(store.rows[0].displayState).toBe("disputed");
  });

  it("sends nothing for a record that fails its form, names no held line, or names the subject otherwise", async () => {
    const malformed = await submit({ ...(await filing()), reason: "" }, T0);
    expect(malformed.code).toBe(2);
    expect(malformed.ingest).not.toHaveBeenCalled();
    expect(malformed.printed).toContain(
      "Not sealed: reason is not 1 to 500 characters, or is blank."
    );
    const otherVersion = await submit(
      await filing({
        line: {
          furnisher_id: FURNISHER,
          event_id: EVENT,
          signed_event_hash: "cd".repeat(32),
        },
      }),
      T0
    );
    expect(otherVersion.code).toBe(2);
    expect(otherVersion.printed).toContain("the Bureau holds no line");
    const spelled = await submit(
      await filing({ subject_ref: { wallet: SUBJECT.toLowerCase() } }),
      T0
    );
    expect(spelled.code).toBe(2);
    expect(spelled.printed).toContain("subject_ref is not exactly the line's");
    expect(store.disputes).toEqual([]);
  });

  it("refuses a dispute on a line reviewers have not released", async () => {
    store.log = store.log.slice(0, 3);
    const { code, printed, ingest } = await submit(await filing(), T0);
    expect(code).toBe(2);
    expect(ingest).not.toHaveBeenCalled();
    expect(printed).toContain("is not released: only a line on a file");
  });

  it("takes the furnisher's confirmation, then one statement, then one appeal", async () => {
    await submit(await filing(), T0);
    const early = await submit(await statement("too early"), at(1));
    expect(early.code).toBe(2);
    expect(early.printed).toContain(
      "a statement follows the furnisher's confirmation"
    );

    const answered = await submit(confirm(), at(2));
    expect(answered.code).toBe(0);
    expect(answered.printed).toContain(
      `Dispute ${DISPUTE_1} is confirmed by the furnisher.`
    );
    expect(store.rows[0].displayState).toBe("disputed");

    expect((await submit(await statement("Not my wallet."), at(3))).code).toBe(
      0
    );
    const again = await submit(await statement("Still not mine."), at(3));
    expect(again.code).toBe(2);
    expect(again.printed).toContain("one statement on");

    const first = await submit(
      await appeal("The evidence names another wallet."),
      at(4)
    );
    expect(first.code).toBe(0);
    expect(first.printed).toContain("appeal by the subject open");
    const second = await submit(await appeal("Please look again."), at(5));
    expect(second.code).toBe(2);
    expect(second.ingest).not.toHaveBeenCalled();
    expect(second.printed).toContain(
      `dispute ${DISPUTE_1} already has an appeal, by the subject; it can be appealed once`
    );
  });

  it("counts for nothing a response signed with another key", async () => {
    await submit(await filing(), T0);
    const { code, printed } = await submit(
      confirm(strangerKey.privateKeyPem),
      at(2)
    );
    expect(code).toBe(1);
    expect(printed).toContain(
      `It counts for nothing: the signature does not verify with ${FURNISHER}'s key levy-key-1.`
    );
    expect(printed).toContain(`Dispute ${DISPUTE_1} is open`);
  });
});

describe("pnpm dispute sync", () => {
  const ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
  // CounterAudit's checkpoint, list and verify routes over the Bureau's organization holding these
  // dispute records from sequence 10, each sealed at its time, in a whole chain (chainOf). Nobody
  // gave them to the operator: their senders sent them to CounterAudit themselves (review AB-02).
  function bureauOrg(
    records: { record: unknown; sealedAt: Date; erasedAt?: Date }[],
    checkpointStatus?: number
  ) {
    const { packets, tip } = chainOf(
      ORG,
      records.map((r, n) => ({
        packet_id: idOf(300 + n),
        org_id: ORG,
        sequence: 10 + n,
        connector_id: "agent-bureau-dispute-v1",
        signed_event: r.record,
        created_at: r.sealedAt.toISOString(),
      }))
    );
    const erasedAt = (packetId: string) => records.find((_, n) => idOf(300 + n) === packetId)?.erasedAt;
    return vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === `/v1/audit/chain/${ORG}/checkpoint`) {
        return checkpointStatus
          ? Response.json({ error: "unavailable" }, { status: checkpointStatus })
          : checkpointResponse(ORG, tip, u.searchParams.get("nonce"));
      }
      if (u.pathname === "/v1/audit/packets") {
        return Response.json({
          packets: packets.map(p => ({
            packet_id: p.packet_id,
            connector_id: p.connector_id,
            created_at: p.created_at,
            expired_at: erasedAt(p.packet_id)?.toISOString() ?? null,
            prev_hash: p.prev_hash,
            entry_hash: p.entry_hash,
          })),
          next_cursor: null,
        });
      }
      const packet = packets.find(p => u.pathname.endsWith(`/${p.packet_id}`));
      if (packet && erasedAt(packet.packet_id)) {
        const signed_statement = erasureStatementOf(ORG, {
          packetId: packet.packet_id,
          sequence: packet.sequence as number,
          entryHash: packet.entry_hash,
          prevHash: packet.prev_hash,
          connectorId: packet.connector_id,
          // CounterAudit's retention job erases a packet once its 24 months are up.
          kind: erasedAt(packet.packet_id)!.getTime() - new Date(packet.created_at as string).getTime() > 700 * 86_400_000 ? "scheduled" : "early",
          expiredAt: erasedAt(packet.packet_id)!.toISOString(),
        });
        return Response.json({ error: "gone", signed_statement }, { status: 410 });
      }
      return packet
        ? Response.json({ valid: true, packet: { org_id: ORG, ...packet } })
        : Response.json({ error: "not_found" }, { status: 404 });
    });
  }
  async function sync(
    records: { record: unknown; sealedAt: Date; erasedAt?: Date }[],
    now: Date,
    checkpointStatus?: number
  ) {
    clock.now = now;
    const f = disputeIO();
    f.io.fetch = bureauOrg(records, checkpointStatus);
    const code = await runDispute(["sync"], f.io);
    return { code, printed: f.out.join("\n") };
  }

  it("stores a dispute its subject sealed in CounterAudit directly, once, and settles its line", async () => {
    const sealed = [{ record: await filing(), sealedAt: T0 }];
    const first = await sync(sealed, at(1));
    expect(first.code).toBe(0);
    expect(store.disputes).toHaveLength(1);
    expect(store.disputes[0]).toMatchObject({
      disputeId: DISPUTE_1,
      kind: "dispute",
      outcomeEventId: 1,
      packetId: idOf(300),
      sequence: 10,
      sealedAt: T0,
      // The receipt went to whoever sent it.
      receipt: null,
      signatureOk: true,
      subjectControlOk: true,
      checkProblem: null,
    });
    expect(first.printed).toContain("1 dispute record sealed; 1 stored now.");
    expect(first.printed).toContain(`${FURNISHER}/${EVENT}: released -> disputed`);
    expect(store.rows[0].displayState).toBe("disputed");

    const again = await sync(sealed, at(2));
    expect(again.code).toBe(0);
    expect(again.printed).toContain("1 dispute record sealed; 0 stored now.");
    expect(store.disputes).toHaveLength(1);
  });

  it("stores a later record on its dispute's line, and waits for a line or dispute it does not hold", async () => {
    const OTHER_EVENT = "levy-sub8-charge9";
    const elsewhere = await filing({
      dispute_id: DISPUTE_2,
      line: { furnisher_id: FURNISHER, event_id: OTHER_EVENT, signed_event_hash: "cd".repeat(32) },
    });
    const elsewhereStatement = await signWithWallet(
      {
        schema: DISPUTE_SCHEMA,
        kind: "statement",
        dispute_id: DISPUTE_2,
        signer: { type: "eip191", address: SUBJECT },
        text: "Not mine either.",
        stated_at: at(1).toISOString(),
      },
      SUBJECT_KEY
    );
    const sealed = [
      { record: elsewhereStatement, sealedAt: at(-1) },
      { record: elsewhere, sealedAt: at(-1) },
      { record: await filing(), sealedAt: T0 },
      { record: confirm(), sealedAt: at(2) },
      { record: await statement("The order log shows another wallet."), sealedAt: at(3) },
    ];
    const first = await sync(sealed, at(4));
    expect(first.code).toBe(0);
    expect(store.disputes.map(d => [d.kind, d.outcomeEventId, d.signatureOk])).toEqual([
      ["dispute", 1, true],
      ["response", 1, true],
      ["statement", 1, true],
    ]);
    expect(first.printed).toContain(
      `Waiting: packet ${idOf(300)} (statement of dispute ${DISPUTE_2}): the Bureau holds no dispute ${DISPUTE_2} yet.`
    );
    expect(first.printed).toContain(
      `Waiting: packet ${idOf(301)} (dispute of dispute ${DISPUTE_2}): the Bureau holds no line ${FURNISHER}/${OTHER_EVENT} yet.`
    );

    // Once the line is held, the next sync stores the dispute, and the one after it the statement
    // that waited for it, though CounterAudit sealed the statement first.
    store.rows.push(line({ eventId: OTHER_EVENT, signedEventHash: "cd".repeat(32) }));
    const second = await sync(sealed, at(5));
    expect(second.printed).toContain("5 dispute records sealed; 1 stored now.");
    const third = await sync(sealed, at(5));
    expect(third.printed).toContain("5 dispute records sealed; 1 stored now.");
    expect(store.disputes.slice(3).map(d => [d.kind, d.outcomeEventId])).toEqual([
      ["dispute", 2],
      ["statement", 2],
    ]);
  });

  it("counts for nothing what submit would have refused, and stores a forged record as failed", async () => {
    const sealed = [
      { record: await filing(), sealedAt: T0 },
      // The same dispute_id again, another version of the line, and another subject.
      { record: await filing({ reason: "Filed twice." }), sealedAt: at(1) },
      {
        record: await filing({
          dispute_id: DISPUTE_2,
          line: { furnisher_id: FURNISHER, event_id: EVENT, signed_event_hash: "ef".repeat(32) },
        }),
        sealedAt: at(1),
      },
      { record: await filing({ dispute_id: DISPUTE_2, subject_ref: { wallet: OTHER } }), sealedAt: at(1) },
      { record: { schema: DISPUTE_SCHEMA, kind: "dispute" }, sealedAt: at(1) },
      // Signed with a key that is not the furnisher's.
      { record: confirm(strangerKey.privateKeyPem), sealedAt: at(2) },
    ];
    const { code, printed } = await sync(sealed, at(3));
    expect(code).toBe(0);
    expect(store.disputes.map(d => [d.kind, d.signatureOk])).toEqual([
      ["dispute", true],
      ["response", false],
    ]);
    expect(printed).toContain(
      `Counts for nothing: packet ${idOf(301)} (dispute of dispute ${DISPUTE_1}): the dispute_id was used by a dispute sealed before.`
    );
    expect(printed).toContain(
      `Counts for nothing: packet ${idOf(302)} (dispute of dispute ${DISPUTE_2}): it names another version of ${FURNISHER}/${EVENT} than the Bureau holds.`
    );
    expect(printed).toContain(
      `Counts for nothing: packet ${idOf(303)} (dispute of dispute ${DISPUTE_2}): subject_ref is not exactly the line's.`
    );
    expect(printed).toContain(`Counts for nothing: packet ${idOf(304)}: `);
    // The forged confirmation does not answer the dispute.
    expect(store.rows[0].displayState).toBe("disputed");
  });

  it("settles nothing over a stored record that is not the one CounterAudit sealed, or was never sealed", async () => {
    const sealed = [{ record: await filing(), sealedAt: T0 }];
    expect((await sync(sealed, at(1))).code).toBe(0);
    const kept = { ...store.disputes[0] };
    const problem = async (change: () => void, reason: string) => {
      change();
      const { code, printed } = await sync(sealed, at(2));
      expect(code).toBe(1);
      expect(printed).toContain(`Problem: ${reason}.`);
      expect(printed).toContain("Not settled: the stored dispute records do not match what CounterAudit sealed.");
      store.disputes = [{ ...kept }];
    };
    await problem(
      () => (store.disputes[0].sealedAt = at(-3)),
      `stored dispute record ${idOf(300)} is not at the sequence and seal time CounterAudit gives it`
    );
    await problem(
      () => (store.disputes[0].record = { ...(kept.record as Record<string, unknown>), reason: "Edited." }),
      `stored dispute record ${idOf(300)} is not the record CounterAudit sealed`
    );
    store.rows.push(line({ eventId: "levy-sub8-charge9" }));
    await problem(
      () => (store.disputes[0].outcomeEventId = 2),
      `stored dispute record ${idOf(300)} is stored on another line than the one its dispute names`
    );
    await problem(
      () => store.disputes.push({ ...kept, id: 2, packetId: idOf(999), disputeId: DISPUTE_2 }),
      `stored dispute record ${idOf(999)} names a packet the Bureau's organization does not hold`
    );
    // As sealed, it settles again.
    expect((await sync(sealed, at(2))).code).toBe(0);
  });

  it("settles nothing when CounterAudit erased a dispute before its line expired or its retention ran out", async () => {
    const early = await sync([{ record: await filing(), sealedAt: T0, erasedAt: at(2) }], at(3));
    expect(early.code).toBe(1);
    expect(early.printed).toContain(
      `Problem: CounterAudit erased dispute packet ${idOf(300)} before its line expired or its retention ran out.`
    );
    // Erased by the retention policy, 24 months after it was sealed.
    const retained = await sync([{ record: await filing(), sealedAt: T0, erasedAt: new Date("2028-11-01T10:00:00.000Z") }], at(3));
    expect(retained.code).toBe(0);
    // Erased with its line, after the Bureau stored it.
    store.disputes = [];
    expect((await sync([{ record: await filing(), sealedAt: T0 }], at(3))).code).toBe(0);
    store.rows[0].expiredAt = at(4);
    store.disputes[0].record = null;
    expect((await sync([{ record: await filing(), sealedAt: T0, erasedAt: at(4) }], at(5))).code).toBe(0);
  });

  it("stores nothing when the organization cannot be read whole, or without its read key", async () => {
    const sealed = [{ record: await filing(), sealedAt: T0 }];
    const unread = await sync(sealed, at(1), 503);
    expect(unread.code).toBe(1);
    expect(unread.printed).toContain("Not read: the Bureau's organization could not be read whole:");
    expect(store.disputes).toHaveLength(0);

    delete process.env.COUNTERAUDIT_READ_KEY;
    const keyless = await sync(sealed, at(1));
    expect(keyless.code).toBe(2);
    expect(keyless.printed).toContain("Not set: COUNTERAUDIT_READ_KEY.");
    expect(store.disputes).toHaveLength(0);
  });
});

describe("settling checks every stored record again", () => {
  it("counts nothing for a stored row whose flags were edited, as review decisions are checked again", async () => {
    // A dispute under the subject's name signed by another wallet, written straight into the
    // table as if it had checked when it was submitted.
    store.disputes.push({
      id: 1,
      disputeId: DISPUTE_1,
      kind: "dispute",
      outcomeEventId: 1,
      record: await filing({}, OTHER_KEY),
      packetId: idOf(1),
      sequence: 1,
      sealedAt: T0,
      receipt: null,
      signatureOk: true,
      subjectControlOk: true,
      checkProblem: null,
      controllerAddress: null,
    });
    const reviewIO: ReviewIO = {
      readText: async () => "",
      writeNewPrivateFile: async () => {},
      writeNewFile: async () => {},
      log: () => {},
      now: () => at(1),
      fetch: vi.fn(),
    };
    await runReview(["settle"], reviewIO);
    expect(store.rows[0].displayState).toBe("released");
    clock.now = at(20);
    const f = disputeIO();
    await runDispute(["settle"], f.io);
    expect(store.rows[0].displayState).toBe("released");

    // The same row with the subject's own signature counts, whatever its flags say.
    store.disputes[0] = {
      ...store.disputes[0],
      record: await filing(),
      signatureOk: false,
      subjectControlOk: false,
    };
    await runReview(["settle"], reviewIO);
    expect(store.rows[0].displayState).toBe("disputed");
  });

  it("checks a confirmation against the key CounterAudit's receipt names for the line", async () => {
    await submit(await filing(), T0);
    expect((await submit(confirm(), at(2))).code).toBe(0);
    clock.now = at(20);
    const f = disputeIO();
    await runDispute(["settle"], f.io);
    expect(store.rows[0].displayState).toBe("disputed");
    // Without that receipt, and with no key listed for the furnisher, the confirmation counts
    // for nothing and the dispute lapses.
    store.rows[0].receipt = null;
    await runDispute(["settle"], disputeIO().io);
    expect(store.rows[0].displayState).toBe("removed");
  });
});

describe("pnpm dispute settle", () => {
  it("removes the line once its dispute has lapsed, and says so", async () => {
    await submit(await filing(), T0);
    const run = async (now: Date) => {
      clock.now = now;
      const f = disputeIO();
      const code = await runDispute(["settle"], f.io);
      return { code, printed: f.out.join("\n") };
    };
    const early = await run(at(14));
    expect(early.code).toBe(0);
    expect(early.printed).toBe(
      "1 line with subject disputes settled, 0 changed."
    );
    expect(store.rows[0].displayState).toBe("disputed");

    const lapsed = await run(at(15));
    expect(lapsed.code).toBe(0);
    expect(lapsed.printed).toContain(
      `${FURNISHER}/${EVENT}: disputed -> removed (dispute ${DISPUTE_1} lapsed at ${at(15).toISOString()} without an answer from the furnisher)`
    );
    expect(store.rows[0].displayState).toBe("removed");

    // pnpm review settle keeps it removed: it can never be released again.
    const reviewIO: ReviewIO = {
      readText: async () => "",
      writeNewPrivateFile: async () => {},
      writeNewFile: async () => {},
      log: () => {},
      now: () => at(40),
      fetch: vi.fn(),
    };
    await runReview(["settle"], reviewIO);
    expect(store.rows[0].displayState).toBe("removed");
    // And a new dispute on it is refused.
    const refused = await submit(
      await filing({ dispute_id: DISPUTE_2 }),
      at(41)
    );
    expect(refused.code).toBe(2);
    expect(refused.printed).toContain("is removed");
  });
});

describe("pnpm dispute sign", () => {
  it("signs a record with the subject's wallet or the furnisher's key, ready to submit", async () => {
    clock.now = T0;
    const f = disputeIO();
    const unsigned = { ...(await filing()) };
    delete unsigned.signature;
    f.files["record.json"] = JSON.stringify(unsigned);
    f.files["wallet.key"] = `${SUBJECT_KEY.slice(2)}\n`;
    f.files["other.key"] = OTHER_KEY;
    f.files["furnisher.pem"] = furnisherKey.privateKeyPem;
    expect(
      await runDispute(
        [
          "sign",
          "record.json",
          "--wallet-key",
          "wallet.key",
          "--out",
          "signed.json",
        ],
        f.io
      )
    ).toBe(0);
    expect(JSON.parse(f.files["signed.json"])).toEqual(await filing());
    // The wallet must be the one the record names, and a dispute is not a furnisher's record.
    expect(
      await runDispute(
        ["sign", "record.json", "--wallet-key", "other.key", "--out", "x.json"],
        f.io
      )
    ).toBe(2);
    expect(
      await runDispute(
        [
          "sign",
          "record.json",
          "--furnisher-key",
          "furnisher.pem",
          "--out",
          "x.json",
        ],
        f.io
      )
    ).toBe(2);
    expect(f.out.join("\n")).toContain("use --wallet-key");

    const response = { ...confirm() };
    delete response.signature;
    f.files["response.json"] = JSON.stringify(response);
    expect(
      await runDispute(
        [
          "sign",
          "response.json",
          "--furnisher-key",
          "furnisher.pem",
          "--out",
          "r.json",
        ],
        f.io
      )
    ).toBe(0);
    expect(JSON.parse(f.files["r.json"])).toEqual(confirm());
  });
});

describe("pnpm review queue and subject disputes", () => {
  async function queue(now: Date) {
    const out: string[] = [];
    const io: ReviewIO = {
      readText: async () => "",
      writeNewPrivateFile: async () => {},
      writeNewFile: async () => {},
      log: line => out.push(line),
      now: () => now,
      fetch: vi.fn(),
    };
    expect(await runReview(["queue"], io)).toBe(0);
    return out.join("\n");
  }

  it("lists open disputes with their deadlines, lapsed ones, and open appeals", async () => {
    expect(await queue(T0)).not.toContain("Subject disputes");

    await submit(await filing(), T0);
    let printed = await queue(at(1));
    expect(printed).toContain(
      `  dispute ${DISPUTE_1} on ${FURNISHER}/${EVENT}: open since ${T0.toISOString()}; the furnisher must answer by ${at(15).toISOString()}`
    );
    expect(printed).toContain("1 open, 0 lapsed, 0 appeals open.");

    await submit(confirm(), at(2));
    await submit(await appeal("The evidence names another wallet."), at(4));
    printed = await queue(at(5));
    expect(printed).toContain(
      `  dispute ${DISPUTE_1} on ${FURNISHER}/${EVENT}: the subject's appeal, sealed ${at(4).toISOString()} (packet ${idOf(3)}), is open: a reviewer's rejection of ${FURNISHER}/${EVENT} upholds it`
    );
    expect(printed).toContain("0 open, 0 lapsed, 1 appeal open.");

    // A second line whose dispute lapsed. Reviewers released it before it was disputed, as a line
    // must have been for its dispute to count.
    reviewLog([
      signReviewDecision(
        {
          schema: REVIEW_SCHEMA,
          reviewer_id: "rev_alice",
          furnisher_id: FURNISHER,
          event_id: "levy-sub8-charge2",
          signed_event_hash: "cd".repeat(32),
          data_class: "test",
          evidence_digest: evidenceDigest(EVIDENCE),
          decision: "approve",
          decided_at: at(-5).toISOString(),
        },
        people.alice.privateKeyPem
      ),
    ]);
    store.rows.push(
      line({
        id: 2,
        eventId: "levy-sub8-charge2",
        signedEventHash: "cd".repeat(32),
      })
    );
    store.disputes.push({
      ...store.disputes[0],
      id: 99,
      disputeId: DISPUTE_2,
      outcomeEventId: 2,
      packetId: idOf(99),
      record: await filing({
        dispute_id: DISPUTE_2,
        line: {
          furnisher_id: FURNISHER,
          event_id: "levy-sub8-charge2",
          signed_event_hash: "cd".repeat(32),
        },
      }),
    });
    printed = await queue(at(20));
    expect(printed).toContain(
      `  dispute ${DISPUTE_2} on ${FURNISHER}/levy-sub8-charge2: lapsed at ${at(15).toISOString()} without an answer from ${FURNISHER}; the line is removed`
    );
    expect(printed).toContain("1 removed after a lapsed dispute");
    expect(printed).toContain("0 open, 1 lapsed, 1 appeal open.");
  });
});
