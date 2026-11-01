// Subject disputes on an agent's file (a line carries its dispute; a lapsed one leaves every file,
// history included) and the subject's view (pnpm file subject), against lines and the review log
// in memory, with CounterAudit stood in.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

const store = vi.hoisted(() => ({
  lines: [] as unknown[],
  log: [] as { id: number; sequence: number; [k: string]: unknown }[],
}));
vi.mock("./db", () => ({
  schemaReady: vi.fn(async () => true),
  listFileLines: vi.fn(async () => store.lines),
  listReviewLogRecords: vi.fn(async () =>
    [...store.log].sort((a, b) => a.sequence - b.sequence)
  ),
  insertReviewLogRecords: vi.fn(async (rows: { sequence: number }[]) => {
    let added = 0;
    for (const row of rows) {
      if (store.log.some(l => l.sequence === row.sequence)) continue;
      store.log.push({ ...row, id: store.log.length + 1 });
      added++;
    }
    return added;
  }),
}));

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

import {
  assembleFile,
  runFile,
  type FileIO,
  type StoredLine,
} from "./agentFile";
import {
  DISPUTE_SCHEMA,
  signWithFurnisherKey,
  signWithWallet,
  walletAddress,
  type StoredDisputeRecord,
} from "./dispute";
import type { Line, Review } from "./lineState";
import { signedEventHash } from "./outcomeProof";
import {
  REVIEW_SCHEMA,
  evidenceDigest,
  newReviewerKey,
  signReviewDecision,
} from "./reviewDecision";
import { REVIEWER_KEY_SCHEMA, genesisHash, signKeyRecord } from "./reviewLog";

const T0 = new Date("2026-11-01T10:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const SUBJECT_KEY = generatePrivateKey();
const SUBJECT = walletAddress(SUBJECT_KEY);
const FURNISHER = "fur_bureaupilot01";
const BUREAU_ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
const REVIEW_ORG = "11111111-2222-4333-8444-555555555555";
const API = "https://api.counteraudit.test";
const EVIDENCE = {
  status: "verified",
  reasons: [],
  funding_screen: { result: "clear", flags: [], gaps: [] },
};
const furnisherKey = newReviewerKey();
const DISPUTE = "6d1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const idOf = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hashOf = (n: number) =>
  n < 0
    ? "0".repeat(64)
    : createHash("sha256").update(`packet ${n}`).digest("hex");

// A stored line read from its signed event, as listFileLines returns it.
function stored(
  n: number,
  options: {
    outcome?: string;
    subject?: Record<string, unknown>;
    relation?: { type: string; target_event_id: string };
    sealedAt?: Date;
    disputes?: StoredDisputeRecord[];
  } = {}
): StoredLine {
  const event = {
    schema_version: "1",
    furnisher_id: FURNISHER,
    key_id: "pilot-2026-10",
    event_id: `event-${n}`,
    subject_ref: options.subject ?? { wallet: SUBJECT },
    occurred_at: at(-20 + n).toISOString(),
    outcome: options.outcome ?? "delivered",
    ...(options.relation ? { relation: options.relation } : {}),
    signature: "ed25519:test",
  };
  const sealedAt = options.sealedAt ?? at(-19 + n);
  return {
    id: n,
    furnisherId: FURNISHER,
    eventId: event.event_id,
    subjectRef: event.subject_ref,
    dataClass: "test",
    proofOk: true,
    evidenceStatus: "verified",
    evidenceResult: EVIDENCE,
    evidenceKey: null,
    signedEventHash: signedEventHash(event),
    displayState: "released",
    relationType: (options.relation?.type ?? null) as Line["relationType"],
    relationTargetEventId: options.relation?.target_event_id ?? null,
    outcome: event.outcome,
    occurredAt: new Date(event.occurred_at),
    receivedAt: sealedAt,
    caCreatedAt: sealedAt,
    packetId: idOf(500 + n),
    entryHash: hashOf(500 + n),
    sequence: 500 + n,
    signedEvent: event,
    expiredAt: null,
    ...(options.disputes ? { disputeRecords: options.disputes } : {}),
  };
}

let nextRecord = 0;
async function disputeRecords(
  line: StoredLine,
  records: {
    kind: "dispute" | "response" | "statement";
    at: Date;
    text?: string;
  }[]
): Promise<StoredDisputeRecord[]> {
  const out: StoredDisputeRecord[] = [];
  for (const r of records) {
    nextRecord++;
    const signer = { type: "eip191", address: SUBJECT };
    const record =
      r.kind === "dispute"
        ? await signWithWallet(
            {
              schema: DISPUTE_SCHEMA,
              kind: "dispute",
              dispute_id: DISPUTE,
              line: {
                furnisher_id: FURNISHER,
                event_id: line.eventId,
                signed_event_hash: line.signedEventHash,
              },
              subject_ref: line.subjectRef,
              signer,
              reason: "I never received this.",
              filed_at: r.at.toISOString(),
            },
            SUBJECT_KEY
          )
        : r.kind === "statement"
          ? await signWithWallet(
              {
                schema: DISPUTE_SCHEMA,
                kind: "statement",
                dispute_id: DISPUTE,
                signer,
                text: r.text ?? "Not mine.",
                stated_at: r.at.toISOString(),
              },
              SUBJECT_KEY
            )
          : signWithFurnisherKey(
              {
                schema: DISPUTE_SCHEMA,
                kind: "response",
                dispute_id: DISPUTE,
                furnisher_id: FURNISHER,
                key_id: "pilot-2026-10",
                response: "confirm",
                evidence: [{ note: "Delivered per the provider log." }],
                responded_at: r.at.toISOString(),
              },
              furnisherKey.privateKeyPem
            );
    out.push({
      id: nextRecord,
      disputeId: DISPUTE,
      kind: r.kind,
      record,
      packetId: idOf(800 + nextRecord),
      sequence: 800 + nextRecord,
      sealedAt: r.at,
      signatureOk: true,
      subjectControlOk: r.kind === "response" ? null : true,
      checkProblem: null,
      controllerAddress: null,
    });
  }
  return out;
}

// One reviewer's approval of each line: test data, so each is released solo_test.
const approvals = (line: Line): Review[] => [
  {
    id: 1,
    reviewerId: "rev_alice",
    decision: "approve",
    signedEventHash: line.signedEventHash,
    dataClass: "test",
    evidenceDigest: evidenceDigest(line.evidenceResult),
    decidedAt: at(-15),
    sealedAt: at(-15),
  },
];

const assemble = (rows: StoredLine[], now: Date) =>
  assembleFile({ wallet: SUBJECT }, rows, approvals, {
    now,
    bureauOrgId: BUREAU_ORG,
    testnetReviewers: false,
    fileId: "file-1",
    proofBase: API,
    furnishers: {},
  }).file;

describe("a subject dispute on an agent's file", () => {
  it("leaves a file without disputes as it was: no dispute field, no new disclosure", () => {
    const rows = [stored(1), stored(2)];
    const without = assemble(rows, at(1));
    const empty = assemble(
      rows.map(r => ({ ...r, disputeRecords: [] })),
      at(1)
    );
    expect(JSON.stringify(empty)).toBe(JSON.stringify(without));
    expect(JSON.stringify(without)).not.toContain('"dispute"');
    expect(
      without.disclosures.some(d => d.includes("disputed by its subject"))
    ).toBe(false);
  });

  it("shows an open dispute on its line with the date and the furnisher's deadline", async () => {
    const line = stored(1);
    line.disputeRecords = await disputeRecords(line, [
      { kind: "dispute", at: T0 },
    ]);
    const file = assemble([line], at(1));
    expect(file.furnished_outcomes[0]).toMatchObject({
      display_state: "disputed",
      released: "solo_test",
      dispute: {
        state: "open",
        filed_at: T0.toISOString(),
        respond_by: at(15).toISOString(),
      },
    });
    expect(
      file.disclosures.some(d =>
        d.startsWith("A line with a dispute was disputed by its subject")
      )
    ).toBe(true);
  });

  it("shows a confirmed dispute with the subject's statement, and no deadline", async () => {
    const line = stored(1);
    line.disputeRecords = await disputeRecords(line, [
      { kind: "dispute", at: T0 },
      { kind: "response", at: at(3) },
      {
        kind: "statement",
        at: at(4),
        text: "The wallet that paid is not mine.",
      },
    ]);
    const [entry] = assemble([line], at(30)).furnished_outcomes;
    expect(entry.display_state).toBe("disputed");
    expect(entry.dispute).toEqual({
      state: "confirmed",
      filed_at: T0.toISOString(),
      confirmed_at: at(3).toISOString(),
      statement: "The wallet that paid is not mine.",
    });
  });

  it("leaves a line whose dispute lapsed off the file, history included, even after the furnisher corrects it", async () => {
    const disputed = stored(1);
    disputed.disputeRecords = await disputeRecords(disputed, [
      { kind: "dispute", at: T0 },
    ]);
    // The furnisher's correction, sealed after the deadline: the route back.
    const correction = stored(2, {
      relation: { type: "corrects", target_event_id: "event-1" },
      sealedAt: at(16),
    });
    const before = assemble([disputed], at(14));
    expect(
      before.furnished_outcomes.map(l => l.counteraudit.packet_id)
    ).toEqual([disputed.packetId]);
    expect(assemble([disputed], at(15)).furnished_outcomes).toEqual([]);

    const after = assemble([disputed, correction], at(20));
    const shown = [...after.furnished_outcomes, ...after.history].map(
      l => l.counteraudit.packet_id
    );
    expect(shown).toEqual([correction.packetId]);
    expect(after.history).toEqual([]);
    // Without the lapse the corrected line would sit in history.
    const undisputed = assemble([stored(1), correction], at(20));
    expect(undisputed.history.map(l => l.counteraudit.packet_id)).toEqual([
      disputed.packetId,
    ]);
  });

  it("closes a dispute the furnisher corrected in time, and keeps the line in history with it", async () => {
    const disputed = stored(1);
    disputed.disputeRecords = await disputeRecords(disputed, [
      { kind: "dispute", at: T0 },
    ]);
    const correction = stored(2, {
      relation: { type: "corrects", target_event_id: "event-1" },
      sealedAt: at(5),
    });
    const file = assemble([disputed, correction], at(20));
    expect(file.history).toHaveLength(1);
    expect(file.history[0]).toMatchObject({
      display_state: "superseded",
      dispute: { state: "corrected", filed_at: T0.toISOString() },
    });
  });
});

// CounterAudit's list and verify routes over a review organization holding these records.
function counterAudit(records: unknown[]) {
  const chain = records.map((record, n) => ({
    packet_id: idOf(n),
    org_id: REVIEW_ORG,
    sequence: n,
    connector_id: "agent-bureau-review-v1",
    signed_event: record,
    integrity: { prev_hash: hashOf(n - 1), entry_hash: hashOf(n) },
    created_at: at(-15).toISOString(),
  }));
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/v1/audit/packets") {
      return Response.json({
        packets: [...chain].reverse().map(p => ({ packet_id: p.packet_id })),
        next_cursor: null,
      });
    }
    const packet = chain.find(p => path.endsWith(p.packet_id));
    if (!packet) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({
      valid: true,
      entry_hash: packet.integrity.entry_hash,
      packet,
    });
  });
}

describe("pnpm file subject", () => {
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
  const approve = (line: StoredLine) =>
    signReviewDecision(
      {
        schema: REVIEW_SCHEMA,
        reviewer_id: "rev_alice",
        furnisher_id: FURNISHER,
        event_id: line.eventId,
        signed_event_hash: line.signedEventHash,
        data_class: "test",
        evidence_digest: evidenceDigest(EVIDENCE),
        decision: "approve",
        decided_at: at(-15).toISOString(),
      },
      people.alice.privateKeyPem
    );

  beforeEach(() => {
    store.log = [];
    pin.genesis = genesisHash(TEAM);
    process.env.DATABASE_URL = "mysql://test";
    process.env.COUNTERAUDIT_ORG_ID = BUREAU_ORG;
    process.env.COUNTERAUDIT_REVIEW_ORG_ID = REVIEW_ORG;
    process.env.COUNTERAUDIT_REVIEW_READ_KEY = "ca_read_review";
    process.env.COUNTERAUDIT_API_URL = API;
  });

  it("writes every line ever released on the subject, with what a file leaves out", async () => {
    const paid = stored(1, { outcome: "paid" });
    paid.disputeRecords = await disputeRecords(paid, [
      { kind: "dispute", at: T0 },
    ]);
    const replaced = stored(2);
    const replacement = stored(3, {
      relation: { type: "supersedes", target_event_id: "event-2" },
    });
    const neverReleased = stored(4);
    const someoneElse = stored(5, {
      subject: { wallet: `0x${"1".repeat(40)}` },
    });
    store.lines = [paid, replaced, replacement, neverReleased, someoneElse];
    const genesis = (["alice", "bob", "carol"] as const).map(p =>
      signKeyRecord(
        {
          schema: REVIEWER_KEY_SCHEMA,
          signer_id: `rev_${p}`,
          change: { type: "genesis", reviewers: TEAM },
          decided_at: at(-15).toISOString(),
        },
        people[p].privateKeyPem
      )
    );
    const fetch = counterAudit([
      ...genesis,
      approve(paid),
      approve(replaced),
      approve(replacement),
      approve(someoneElse),
    ]);
    const out: string[] = [];
    const files: Record<string, string> = {};
    const io = {
      readText: async () => "",
      writeNewPrivateFile: async () => {},
      writeNewFile: async (p: string, text: string) => {
        files[p] = text;
      },
      log: (line: string) => out.push(line),
      now: () => at(1),
      fetchProof: vi.fn(),
      fetch,
      jwks: { keys: [] },
      keys: {},
      furnishers: {},
      sigvara: {} as FileIO["sigvara"],
    } as FileIO;
    const code = await runFile(
      [
        "subject",
        "--subject",
        JSON.stringify({ wallet: SUBJECT }),
        "--out",
        "view.json",
      ],
      io
    );
    expect(out.join("\n")).toContain(
      "3 lines ever released and 1 dispute, written to view.json"
    );
    expect(code).toBe(0);
    const view = JSON.parse(files["view.json"]);
    expect(view).toMatchObject({
      schema: "agent-bureau/subject-view/v1",
      issued_at: at(1).toISOString(),
      subject: { subject_ref: { wallet: SUBJECT }, matching: "exact" },
      review_log: { org_id: REVIEW_ORG, sequence: 6, packet_id: idOf(6) },
    });
    expect(view.lines.map((l: { event_id: string }) => l.event_id)).toEqual([
      "event-3",
      "event-2",
      "event-1",
    ]);
    const [, second, first] = view.lines;
    expect(first).toMatchObject({
      furnisher_id: FURNISHER,
      furnisher_category: "Bureau pilot test furnisher",
      outcome: "paid",
      display_state: "disputed",
      signed_event: paid.signedEvent,
      counteraudit: {
        packet_id: paid.packetId,
        org_id: BUREAU_ORG,
        proof_url: `${API}/v1/proofs/${paid.packetId}`,
        signed_event_hash: paid.signedEventHash,
      },
      evidence: { status: "verified", proved: "payment_settlement_verified" },
      payment: {
        subject_control: "unproven",
        payer_independence_screen: { result: "clear", flags: [], gaps: [] },
      },
      release: {
        released: "solo_test",
        holding_back: null,
        decisions: [
          {
            reviewer_id: "rev_alice",
            decision: "approve",
            for_this_event: true,
            review_log: { org_id: REVIEW_ORG, sequence: 3, packet_id: idOf(3) },
          },
        ],
      },
      correction_history: [],
    });
    expect(first.evidence.not_proved.join(" ")).toContain(
      "subject control is unproven until Phase 3"
    );
    expect(first.disputes).toEqual([
      {
        dispute_id: DISPUTE,
        state: "open",
        filed_at: T0.toISOString(),
        respond_by: at(15).toISOString(),
        appeal: null,
        records: [
          {
            kind: "dispute",
            packet_id: paid.disputeRecords![0].packetId,
            sequence: paid.disputeRecords![0].sequence,
            sealed_at: T0.toISOString(),
            signature_checked: true,
            subject_control_checked: true,
            problem: null,
            record: paid.disputeRecords![0].record,
          },
        ],
      },
    ]);
    expect(second).toMatchObject({
      display_state: "superseded",
      correction_history: [
        {
          event_id: "event-3",
          relation: "supersedes",
          acts: true,
          packet_id: replacement.packetId,
          signed_event: replacement.signedEvent,
        },
      ],
    });
    expect(view.how_to_dispute.join(" ")).toContain("personal_sign (EIP-191)");
    expect(view.how_to_dispute.join(" ")).toContain("15 days");
  });
});
