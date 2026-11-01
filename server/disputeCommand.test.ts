// pnpm dispute submit, settle and sign, and the dispute lines of pnpm review queue, against the
// Bureau's lines, dispute records and review log in memory, with CounterAudit and Sigvara stood in.
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
    receipt: {
      outcome_claim: { signer: { public_key: furnisherKey.publicKey } },
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

    // A second line whose dispute lapsed.
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
