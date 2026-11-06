import { createHash, createPrivateKey, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The review log's checkpoints in these fakes are signed with a key made for the test run
// (server/testCheckpoint.ts); the pinned keys gain it in this file only.
vi.mock("./counterauditKeys", async importOriginal => {
  const actual = await importOriginal<typeof import("./counterauditKeys")>();
  const { TEST_EXPORT_KEY } = await import("./testCheckpoint");
  return { COUNTERAUDIT_EXPORT_KEYS: { keys: [...actual.COUNTERAUDIT_EXPORT_KEYS.keys, TEST_EXPORT_KEY] } };
});
import { checkpointResponse } from "./testCheckpoint";

// The Bureau's lines and its copy of the review log, in memory.
type Row = {
  id: number;
  furnisherId: string;
  eventId: string;
  outcome: string;
  subjectRef: Record<string, unknown>;
  dataClass: "test" | "live";
  proofOk: boolean;
  evidenceStatus: string | null;
  evidenceResult: Record<string, unknown> | null;
  signedEventHash: string;
  displayState: string;
  relationType: string | null;
  relationTargetEventId: string | null;
  signedEvent?: unknown;
  receipt?: unknown;
};
type LogRow = {
  id: number;
  sequence: number;
  packetId: string;
  prevHash: string;
  entryHash: string;
  connectorId: string;
  sealedAt: Date;
  record: unknown;
  readAt: Date;
};
type SyncRow = {
  lastAttemptAt: Date;
  lastSuccessAt: Date | null;
  listedCount: number | null;
  listedAt: Date | null;
  problem: string | null;
  checkpointSequence?: number | null;
  checkpointEntryHash?: string | null;
  checkpointIssuedAt?: Date | null;
  orgId?: string | null;
};
type MoveRow = {
  fromOrgId: string | null;
  toOrgId: string;
  fromPackets: number;
  fromCheckpointSequence: number | null;
  fromCheckpointEntryHash: string | null;
  pinnedGenesis: string | null;
  movedAt: Date;
};
const store = vi.hoisted(() => ({
  rows: [] as Row[],
  log: [] as LogRow[],
  sync: undefined as SyncRow | undefined,
  moves: [] as MoveRow[],
}));

const db = vi.hoisted(() => ({
  schemaReady: vi.fn(async () => true),
  getOutcomeLine: vi.fn(async (f: string, e: string) => {
    const row = store.rows.find(r => r.furnisherId === f && r.eventId === e);
    return row && { ...row };
  }),
  findRelatingOutcomeLines: vi.fn(async (f: string, e: string) =>
    store.rows
      .filter(r => r.furnisherId === f && r.relationTargetEventId === e)
      .map(r => ({ ...r }))
  ),
  listOutcomeLines: vi.fn(async () => store.rows.map(r => ({ ...r }))),
  listReviewLogRecords: vi.fn(async () =>
    [...store.log].sort((a, b) => a.sequence - b.sequence)
  ),
  insertReviewLogRecords: vi.fn(async (rows: Omit<LogRow, "id">[]) => {
    let added = 0;
    for (const row of rows) {
      if (store.log.some(l => l.sequence === row.sequence)) continue;
      store.log.push({ ...row, id: store.log.length + 1 });
      added++;
    }
    return added;
  }),
  setOutcomeEventDisplayState: vi.fn(async (id: number, state: string) => {
    store.rows.find(r => r.id === id)!.displayState = state;
  }),
  // As server/db.ts recordReviewLogSync merges them.
  getReviewLogSync: vi.fn(async () => store.sync && { ...store.sync }),
  recordReviewLogSync: vi.fn(
    async (s: { at: Date; problem: string | null; listedCount: number | null }) => {
      store.sync = {
        lastSuccessAt: null,
        listedCount: null,
        listedAt: null,
        ...store.sync,
        lastAttemptAt: s.at,
        problem: s.problem,
        ...(s.problem ? {} : { lastSuccessAt: s.at }),
        ...(s.listedCount === null ? {} : { listedCount: s.listedCount, listedAt: s.at }),
      };
    }
  ),
  // As server/db.ts keeps the head: never moved back.
  getReviewLogHead: vi.fn(async () =>
    store.sync?.checkpointSequence != null && store.sync.checkpointEntryHash
      ? { sequence: store.sync.checkpointSequence, entryHash: store.sync.checkpointEntryHash }
      : null
  ),
  recordReviewLogCheckpoint: vi.fn(
    async (c: { sequence: number; entryHash: string; issuedAt: Date }, at: Date) => {
      store.sync ??= { lastAttemptAt: at, lastSuccessAt: null, listedCount: null, listedAt: null, problem: null };
      if (store.sync.checkpointSequence != null && store.sync.checkpointSequence >= c.sequence) return;
      Object.assign(store.sync, {
        checkpointSequence: c.sequence,
        checkpointEntryHash: c.entryHash,
        checkpointIssuedAt: c.issuedAt,
      });
    }
  ),
  // As server/db.ts records the organization: only the first time.
  bindReviewLogOrg: vi.fn(async (orgId: string, at: Date) => {
    store.sync ??= { lastAttemptAt: at, lastSuccessAt: null, listedCount: null, listedAt: null, problem: null };
    store.sync.orgId ??= orgId;
  }),
  getReviewLogMoveHead: vi.fn(async (orgId: string) => {
    const left = [...store.moves].reverse().find(m => m.fromOrgId === orgId);
    return left?.fromCheckpointSequence != null && left.fromCheckpointEntryHash
      ? { sequence: left.fromCheckpointSequence, entryHash: left.fromCheckpointEntryHash }
      : null;
  }),
  // As server/db.ts moves the copy: all at once.
  moveReviewLog: vi.fn(
    async (move: {
      toOrgId: string;
      rows: Omit<LogRow, "id">[];
      checkpoint: { sequence: number; entryHash: string; issuedAt: Date } | null;
      pinnedGenesis: string | null;
      at: Date;
    }) => {
      store.moves.push({
        fromOrgId: store.sync?.orgId ?? null,
        toOrgId: move.toOrgId,
        fromPackets: store.log.length,
        fromCheckpointSequence: store.sync?.checkpointSequence ?? null,
        fromCheckpointEntryHash: store.sync?.checkpointEntryHash ?? null,
        pinnedGenesis: move.pinnedGenesis,
        movedAt: move.at,
      });
      store.log = move.rows.map((row, n) => ({ ...row, id: n + 1 }));
      store.sync = {
        orgId: move.toOrgId,
        lastAttemptAt: move.at,
        lastSuccessAt: move.at,
        listedCount: move.rows.length,
        listedAt: move.at,
        problem: null,
        checkpointSequence: move.checkpoint?.sequence ?? null,
        checkpointEntryHash: move.checkpoint?.entryHash ?? null,
        checkpointIssuedAt: move.checkpoint?.issuedAt ?? null,
      };
    }
  ),
}));
vi.mock("./db", () => db);

// The genesis the Bureau counts (REVIEW_GENESIS in server/reviewLog.ts), pinned
// to these tests' reviewers unless a test says otherwise.
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

import { evidenceLabel, runReview, type ReviewIO } from "./review";
import { keyApprovalVerifies, payloadDigest } from "./keyApproval";
import { ADMISSION_SCHEMA, signAdmission, type UnsignedAdmission } from "./furnisherAdmission";
import { canonicalizeJson, signedEventHash } from "./outcomeProof";
import {
  REVIEW_SCHEMA,
  checkReviewDecision,
  evidenceDigest,
  newReviewerKey,
  signReviewDecision,
  type ReviewDecision,
} from "./reviewDecision";
import {
  REVIEWER_KEY_SCHEMA,
  genesisHash,
  replayReviewLog,
  signKeyRecord,
  type KeyChange,
} from "./reviewLog";

const NOW = new Date("2026-10-31T12:00:00.000Z");
// The lines' signed event, signed with the furnisher's key as the furnisher tool signs it.
const FURNISHER_SIGNER = newReviewerKey();
const unsignedEvent = {
  schema_version: "1",
  furnisher_id: "fur_levymerchant1",
  key_id: "levy-1",
  event_id: "levy-sub8-charge1",
  subject_ref: { wallet: "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77" },
  occurred_at: "2026-10-31T10:00:00.000Z",
  outcome: "paid",
};
const EVENT = {
  ...unsignedEvent,
  signature: `ed25519:${sign(null, Buffer.from(`agent-bureau/outcome-event/v1\n${canonicalizeJson(unsignedEvent)}`, "utf8"), createPrivateKey(FURNISHER_SIGNER.privateKeyPem)).toString("base64url")}`,
};
const HASH = signedEventHash(EVENT);
const EVIDENCE = { status: "verified", reasons: [] };
const API = "https://api.counteraudit.test";
const ORG = "11111111-2222-4333-8444-555555555555";
const LINE = "fur_levymerchant1/levy-sub8-charge1";
const people = {
  alice: newReviewerKey(),
  bob: newReviewerKey(),
  carol: newReviewerKey(),
};
type Person = keyof typeof people;
const TEAM = (["alice", "bob", "carol"] as const).map(p => ({
  reviewer_id: `rev_${p}`,
  name: p[0].toUpperCase() + p.slice(1),
  public_key: people[p].publicKey,
}));
const idOf = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hashOf = (n: number) =>
  n < 0 ? "0".repeat(64) : createHash("sha256").update(`packet ${n}`).digest("hex");

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: store.rows.length + 1,
    furnisherId: "fur_levymerchant1",
    eventId: "levy-sub8-charge1",
    outcome: "paid",
    subjectRef: { wallet: "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77" },
    dataClass: "test",
    proofOk: true,
    evidenceStatus: "verified",
    evidenceResult: EVIDENCE,
    signedEventHash: HASH,
    displayState: "unverified",
    relationType: null,
    relationTargetEventId: null,
    ...overrides,
  };
}

// The organization and key a live line came from, as its receipt names them.
const FURNISHER_ORG = "99999999-8888-4777-8666-555555555555";
const FURNISHER_KEY = FURNISHER_SIGNER.publicKey;
const signedBy = {
  signedEvent: EVENT,
  receipt: { org_id: FURNISHER_ORG, outcome_claim: { signer: { key_id: "levy-1", public_key: FURNISHER_KEY } } },
};

// A reviewer's admission of the lines' furnisher, for that organization and key.
const admission = (reviewer: Person, overrides: Record<string, unknown> = {}) =>
  signAdmission(
    {
      schema: ADMISSION_SCHEMA,
      reviewer_id: `rev_${reviewer}`,
      furnisher_id: "fur_levymerchant1",
      decision: "admit",
      counteraudit_org_id: FURNISHER_ORG,
      keys: [{ key_id: "levy-1", public_key: FURNISHER_KEY }],
      arms_length: true,
      probation_days: 90,
      decided_at: "2026-10-31T11:00:00.000Z",
      ...overrides,
    } as UnsignedAdmission,
    people[reviewer].privateKeyPem
  );

function decision(
  reviewer: Person,
  overrides: Partial<ReviewDecision> = {}
): ReviewDecision {
  return signReviewDecision(
    {
      schema: REVIEW_SCHEMA,
      reviewer_id: `rev_${reviewer}`,
      furnisher_id: "fur_levymerchant1",
      event_id: "levy-sub8-charge1",
      signed_event_hash: HASH,
      data_class: "test",
      evidence_digest: evidenceDigest(EVIDENCE),
      decision: "approve",
      decided_at: "2026-10-31T11:00:00.000Z",
      ...overrides,
    },
    people[reviewer].privateKeyPem
  );
}

const keyRecord = (signer: Person, change: KeyChange) =>
  signKeyRecord(
    {
      schema: REVIEWER_KEY_SCHEMA,
      signer_id: `rev_${signer}`,
      change,
      decided_at: "2026-10-31T11:00:00.000Z",
    },
    people[signer].privateKeyPem
  );
const genesis = () =>
  (["alice", "bob", "carol"] as const).map(p =>
    keyRecord(p, { type: "genesis", reviewers: TEAM })
  );

// Records as pnpm review sync would have stored them, from sequence 0.
function seal(...records: unknown[]) {
  for (const record of records) {
    const sequence = store.log.length;
    store.log.push({
      id: sequence + 1,
      sequence,
      packetId: idOf(sequence),
      prevHash: hashOf(sequence - 1),
      entryHash: hashOf(sequence),
      connectorId: "agent-bureau-review-v1",
      sealedAt: NOW,
      record,
      readAt: NOW,
    });
  }
}

// CounterAudit's list and verify routes over a review organization holding these records.
function counterAudit(
  records: unknown[],
  skip: number[] = [],
  place: { org?: string; base?: number; sealedAt?: Date } = {}
) {
  const { org = ORG, base = 0, sealedAt = NOW } = place;
  const chain = records
    .map((record, n) => ({
      packet_id: idOf(base + n),
      org_id: org,
      sequence: n,
      connector_id: "agent-bureau-review-v1",
      signed_event: record,
      integrity: { prev_hash: n === 0 ? hashOf(-1) : hashOf(base + n - 1), entry_hash: hashOf(base + n) },
      created_at: sealedAt.toISOString(),
    }))
    .filter(p => !skip.includes(p.sequence));
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const checkpointPath = /^\/v1\/audit\/chain\/([^/]+)\/checkpoint$/.exec(path);
    if (checkpointPath) {
      const tip = chain.at(-1) as { sequence: number; packet_id: string; integrity: { entry_hash: string } } | undefined;
      return checkpointResponse(
        checkpointPath[1],
        tip ? { sequence: tip.sequence, entryHash: tip.integrity.entry_hash, packetId: tip.packet_id } : null,
        new URL(url).searchParams.get("nonce")
      );
    }
    if (path === "/v1/audit/packets") {
      return Response.json({
        packets: [...chain].reverse().map(p => ({ packet_id: p.packet_id })),
        next_cursor: null,
      });
    }
    const packet = chain.find(p => path.endsWith(p.packet_id))!;
    return Response.json({
      valid: true,
      entry_hash: packet.integrity.entry_hash,
      packet,
    });
  });
}

function fakeIO(
  files: Record<string, string> = {},
  fetch: ReviewIO["fetch"] = async () => {
    throw new Error("no network in this test");
  }
) {
  const output: string[] = [];
  const written: Record<string, string> = {};
  const io: ReviewIO = {
    readText: async path => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    writeNewPrivateFile: async (path, text) => {
      if (path in files || path in written) throw new Error(`EEXIST: ${path}`);
      written[path] = text;
    },
    writeNewFile: async (path, text) => {
      if (path in files || path in written) throw new Error(`EEXIST: ${path}`);
      written[path] = text;
    },
    log: line => output.push(line),
    now: () => NOW,
    fetch,
  };
  return { io, written, printed: () => output.join("\n") };
}

const keys = () =>
  Object.fromEntries(
    Object.entries(people).map(([p, k]) => [`${p}.pem`, k.privateKeyPem])
  );

beforeEach(() => {
  store.rows = [];
  store.log = [];
  store.sync = undefined;
  store.moves = [];
  pin.genesis = genesisHash(TEAM);
  vi.stubEnv("DATABASE_URL", "mysql://bureau:secret@127.0.0.1/bureau");
  vi.stubEnv("COUNTERAUDIT_API_URL", API);
  vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", ORG);
  vi.stubEnv("COUNTERAUDIT_REVIEW_READ_KEY", "ca_read_bureau");
  vi.stubEnv("COUNTERAUDIT_REVIEW_INGEST_KEY", "ca_ingest_alice");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("pnpm review keygen, sign and key, on the reviewer's machine", () => {
  it("writes a new private key file and prints the public key", async () => {
    const { io, written, printed } = fakeIO();
    expect(await runReview(["keygen", "alice.pem"], io)).toBe(0);
    expect(written["alice.pem"]).toContain("BEGIN PRIVATE KEY");
    expect(printed()).toMatch(/Public key: ed25519:[A-Za-z0-9_-]{43}/);
    expect(printed()).toContain("in the genesis every first reviewer signs, or in an add two reviewers sign");
    expect(printed()).not.toContain("BEGIN PRIVATE KEY");
    expect(db.schemaReady).not.toHaveBeenCalled();
  });

  it("never overwrites an existing key file", async () => {
    const { io } = fakeIO(keys());
    expect(await runReview(["keygen", "alice.pem"], io)).toBe(2);
  });

  it("signs a decision that checks with the reviewer's key, without touching the database", async () => {
    const { io, written, printed } = fakeIO(keys());
    const code = await runReview(
      [
        "sign",
        "--key",
        "alice.pem",
        "--reviewer",
        "rev_alice",
        "--line",
        LINE,
        "--hash",
        HASH,
        "--data-class",
        "test",
        "--evidence",
        evidenceDigest(EVIDENCE),
        "--decision",
        "approve_with_waiver",
        "--reason",
        "checked the provider log",
        "--out",
        "d.json",
      ],
      io
    );
    expect(code).toBe(0);
    expect(printed()).toContain("Signed and written to d.json. Seal it with: pnpm review submit d.json");
    const signed = JSON.parse(written["d.json"]);
    expect(signed).toMatchObject({
      reviewer_id: "rev_alice",
      decision: "approve_with_waiver",
      reason: "checked the provider log",
      decided_at: NOW.toISOString(),
    });
    const team = { rev_alice: { name: "Alice", publicKey: people.alice.publicKey } };
    expect(checkReviewDecision(signed, team, NOW).ok).toBe(true);
    expect(db.schemaReady).not.toHaveBeenCalled();
  });

  it("signs one genesis per reviewer, which takes effect once all three are sealed", async () => {
    const files = { ...keys(), "team.json": JSON.stringify(TEAM) };
    const records = [];
    for (const p of ["alice", "bob", "carol"]) {
      const { io, written, printed } = fakeIO(files);
      expect(
        await runReview(["key", "--key", `${p}.pem`, "--signer", `rev_${p}`, "--genesis", "team.json", "--out", "g.json"], io)
      ).toBe(0);
      // The hash each reviewer checks against the pin.
      expect(printed()).toContain(`Genesis hash: ${genesisHash(TEAM)}.`);
      records.push(JSON.parse(written["g.json"]));
    }
    const log = replayReviewLog(
      records.map((record, sequence) => ({ sequence, packetId: idOf(sequence), sealedAt: NOW, record }))
    );
    expect([...log.reviewers!.keys()]).toEqual(["rev_alice", "rev_bob", "rev_carol"]);
  });

  it("refuses to sign a genesis that names another key for the signer", async () => {
    const { io, printed } = fakeIO({ ...keys(), "team.json": JSON.stringify(TEAM) });
    expect(
      await runReview(["key", "--key", "bob.pem", "--signer", "rev_alice", "--genesis", "team.json", "--out", "g.json"], io)
    ).toBe(2);
    expect(printed()).toBe("This key is not the key the genesis names for rev_alice. Nothing signed.");
  });

  it("signs a key change, and takes exactly one change with the flags it needs", async () => {
    const dave = newReviewerKey();
    const { io, written } = fakeIO(keys());
    expect(
      await runReview(
        ["key", "--key", "alice.pem", "--signer", "rev_alice", "--add", "rev_dave", "--name", "Dave", "--public-key", dave.publicKey, "--reason", "fourth reviewer", "--out", "k.json"],
        io
      )
    ).toBe(0);
    expect(JSON.parse(written["k.json"])).toMatchObject({
      schema: REVIEWER_KEY_SCHEMA,
      signer_id: "rev_alice",
      change: { type: "add", reviewer_id: "rev_dave", name: "Dave", public_key: dave.publicKey },
      reason: "fourth reviewer",
    });

    for (const args of [
      ["--suspend", "rev_bob", "--name", "Bob"],
      ["--suspend", "rev_bob", "--remove", "rev_carol"],
      ["--rotate", "rev_bob"],
      ["--promote", "rev_bob"],
      ["--suspend", "rev_bob", "--suspend", "rev_carol"],
      [],
    ]) {
      const bad = fakeIO(keys());
      expect(await runReview(["key", "--key", "alice.pem", "--signer", "rev_alice", "--out", "k.json", ...args], bad.io)).toBe(2);
      expect(bad.printed()).toMatch(/^Usage:/);
    }
  });
});

describe("pnpm review approve-key, on the reviewer's machine", () => {
  const REQUEST = {
    id: "5b0c1f2e-8a4d-4c3b-9e1f-0a2b3c4d5e6f",
    org_id: ORG,
    operation: "create_key",
    payload: { label: "rev_dave ingest", expires_in_days: 90, role: "ingest" },
    required_approvals: 0,
    status: "pending",
  };
  const run = (request: unknown) => {
    const out = fakeIO({ ...keys(), "request.json": JSON.stringify(request) });
    return {
      ...out,
      code: runReview(
        ["approve-key", "--key", "alice.pem", "--reviewer", "rev_alice", "--request", "request.json", "--out", "a.json"],
        out.io
      ),
    };
  };

  it("signs an approval of exactly that request, and says what it approves", async () => {
    const { code, written, printed } = run(REQUEST);
    expect(await code).toBe(0);
    const approval = JSON.parse(written["a.json"]);
    expect(approval).toMatchObject({
      schema: "agent-bureau/key-approval/v1",
      reviewer_id: "rev_alice",
      org_id: ORG,
      request_id: REQUEST.id,
      operation: "create_key",
      payload_sha256: payloadDigest(REQUEST.payload),
      decided_at: NOW.toISOString(),
    });
    expect(keyApprovalVerifies(approval, people.alice.publicKey)).toBe(true);
    expect(printed()).toContain(
      `Approving request ${REQUEST.id} in organization ${ORG}: create a key with role "ingest", labelled "rev_dave ingest", expiring in 90 days.`
    );
    expect(printed()).toContain(`POST /v1/admin/keys/requests/${REQUEST.id}/reviewer-approval`);
    expect(db.schemaReady).not.toHaveBeenCalled();
  });

  it("names the key a revocation is for, and says when CounterAudit did not find it", async () => {
    const revoke = {
      ...REQUEST,
      reviewer_approvals_required: 2,
      operation: "revoke_key",
      payload: { key_id: "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d", label: "rev_bob ingest", role: "ingest", key_prefix: "ca_live_1234" },
    };
    const named = run(revoke);
    expect(await named.code).toBe(0);
    expect(named.printed()).toContain(
      'revoke key "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d": role "ingest", labelled "rev_bob ingest", prefix "ca_live_1234". It runs once 2 different reviewers approve it.'
    );
    const unknown = run({ ...revoke, payload: { key_id: "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d" } });
    expect(await unknown.code).toBe(0);
    expect(unknown.printed()).toContain("which CounterAudit did not find in this organization");
  });

  it("refuses a request that is not pending, not approvable, not a request, hides characters or is another organization's", async () => {
    const other = "11111111-2222-4333-8444-000000000000";
    for (const [request, said] of [
      [{ ...REQUEST, status: "executed" }, "The request is executed, not pending. Nothing signed."],
      [{ ...REQUEST, operation: "erase_packet" }, "A reviewer approves only create_key, revoke_key, set_review_org; this request is erase_packet. Nothing signed."],
      [{ ...REQUEST, payload: "x" }, "request.json is not an approval request as GET /v1/admin/keys/requests/:id returns it. Nothing signed."],
      // An escape sequence that would redraw the line to read "role read".
      [
        { ...REQUEST, payload: { ...REQUEST.payload, role: "admin", label: '[17Dread, labelled "ci' } },
        "The request holds control or formatting characters, which could hide what it does. Nothing signed; ask the operator for a request without them.",
      ],
      [
        { ...REQUEST, payload: { ...REQUEST.payload, label: "ci‮gnirtsd" } },
        "The request holds control or formatting characters, which could hide what it does. Nothing signed; ask the operator for a request without them.",
      ],
      [{ ...REQUEST, org_id: other }, `The request is for organization "${other}", not the review organization ${ORG}. Nothing signed.`],
    ] as const) {
      const { code, written, printed } = run(request);
      expect(await code).toBe(2);
      expect(printed()).toBe(said);
      expect(written["a.json"]).toBeUndefined();
    }
  });
});

describe("pnpm review submit", () => {
  it("seals a record with the reviewer's own ingest key and keeps CounterAudit's receipt", async () => {
    const receipt = { packet_id: idOf(4), entry_hash: "ef".repeat(32), signature: "sig" };
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ packet_id: idOf(4), sequence: 4, receipt }, { status: 201 })
    );
    const signed = decision("alice");
    const { io, written, printed } = fakeIO({ "d.json": `${JSON.stringify(signed)}\n` }, fetch);

    expect(await runReview(["submit", "d.json"], io)).toBe(0);
    expect(printed()).toBe(
      [
        `Sealed in the review log: packet ${idOf(4)}, sequence 4. Once the operator syncs, pnpm review queue lists it there.`,
        "Receipt written to d.json.receipt.json. Keep it.",
      ].join("\n")
    );
    expect(JSON.parse(written["d.json.receipt.json"])).toEqual(receipt);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${API}/v1/audit/ingest`);
    expect(init).toMatchObject({ headers: { authorization: "Bearer ca_ingest_alice" } });
    expect(JSON.parse(String(init!.body)).raw_event).toEqual(signed);
    expect(db.schemaReady).not.toHaveBeenCalled();
  });

  it("seals nothing that is not a review record, and needs the reviewer's ingest key", async () => {
    const fetch = vi.fn();
    const notRecord = fakeIO({ "d.json": '{"schema":"other"}' }, fetch);
    expect(await runReview(["submit", "d.json"], notRecord.io)).toBe(2);
    expect(notRecord.printed()).toBe("d.json holds no review decision, reviewer-key record or furnisher admission. Nothing sealed.");

    vi.stubEnv("COUNTERAUDIT_REVIEW_INGEST_KEY", "");
    const noKey = fakeIO({ "d.json": JSON.stringify(decision("alice")) }, fetch);
    expect(await runReview(["submit", "d.json"], noKey.io)).toBe(2);
    expect(noKey.printed()).toContain("Not set: COUNTERAUDIT_REVIEW_INGEST_KEY");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("exits 1 when CounterAudit refuses the record", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: "review_record_invalid", message: "bad" }, { status: 422 })
    );
    const { io, printed } = fakeIO({ "d.json": JSON.stringify(decision("alice")) }, fetch);
    expect(await runReview(["submit", "d.json"], io)).toBe(1);
    expect(printed()).toBe("Not sealed: CounterAudit refused it (422 review_record_invalid: bad).");
  });
});

describe("pnpm review sync", () => {
  it("reads the review log, says what each key record did, and releases lines", async () => {
    store.rows.push(row({ dataClass: "live", ...signedBy }));
    const records = [
      ...genesis(),
      admission("alice"),
      admission("bob"),
      decision("alice", { data_class: "live" }),
      decision("bob", { data_class: "live" }),
    ];
    const { io, printed } = fakeIO({}, counterAudit(records));

    expect(await runReview(["sync"], io)).toBe(0);
    expect(store.log).toHaveLength(7);
    expect(store.rows[0].displayState).toBe("released");
    expect(printed()).toBe(
      [
        "Read 7 new packets.",
        "  sequence 0: rev_alice signed the genesis of rev_alice, rev_bob, rev_carol",
        "  sequence 1: rev_bob signed the genesis of rev_alice, rev_bob, rev_carol",
        "  sequence 2: genesis of rev_alice, rev_bob, rev_carol took effect, signed by all of them",
        "  sequence 3: rev_alice voted to admit fur_levymerchant1 (1 of 2)",
        "  sequence 4: fur_levymerchant1 admitted by rev_alice and rev_bob, on probation for 90 days",
        "Review log read to sequence 6.",
        "Reviewers: rev_alice (Alice) active, rev_bob (Bob) active, rev_carol (Carol) active.",
        `${LINE}: unverified -> released`,
        "1 line settled, 1 changed.",
      ].join("\n")
    );

    const again = fakeIO({}, counterAudit(records));
    expect(await runReview(["sync"], again.io)).toBe(0);
    expect(again.printed()).toContain("Read 0 new packets.");
  });

  it("stops at a gap, keeping what comes before it, and exits 1", async () => {
    store.rows.push(row());
    const records = [...genesis(), decision("bob", { decision: "reject", reason: "related payer" }), decision("alice")];
    const { io, printed } = fakeIO({}, counterAudit(records, [3]));

    expect(await runReview(["sync"], io)).toBe(1);
    expect(store.log.map(r => r.sequence)).toEqual([0, 1, 2]);
    // Bob's rejection is the packet missing, and Alice's approval past the gap
    // does not count, so the line stays as it was.
    expect(store.rows[0].displayState).toBe("unverified");
    expect(printed()).toContain(
      "Stopped: the chain breaks between sequence 2 and 4; read up to 2. Nothing past it counts until it is resolved."
    );
  });

  it("records each run for the queue: the head CounterAudit listed, the last success and why it stopped", async () => {
    const records = [...genesis(), decision("bob", { decision: "reject", reason: "related payer" }), decision("alice")];
    expect(await runReview(["sync"], fakeIO({}, counterAudit(records.slice(0, 3))).io)).toBe(0);
    expect(store.sync).toEqual({
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
      listedCount: 3,
      listedAt: NOW,
      problem: null,
      checkpointSequence: 2,
      checkpointEntryHash: hashOf(2),
      checkpointIssuedAt: new Date("2026-11-03T12:00:00.000Z"),
      orgId: ORG,
    });

    // A later run stopped at a gap keeps the last success and records the new head.
    const later = new Date(NOW.getTime() + 3_600_000);
    const gap = fakeIO({}, counterAudit(records, [3]));
    gap.io.now = () => later;
    expect(await runReview(["sync"], gap.io)).toBe(1);
    expect(store.sync).toMatchObject({ lastAttemptAt: later, lastSuccessAt: NOW, listedCount: 4, listedAt: later });
    expect(store.sync!.problem).toBe("the chain breaks between sequence 2 and 4; read up to 2");
    // A read that stopped still records the signed head it was shown, which the next read must reach.
    expect(store.sync!.checkpointSequence).toBe(4);

    // One that could not list at all keeps the last complete count.
    const down = fakeIO({}, async () => new Response(null, { status: 503 }));
    expect(await runReview(["sync"], down.io)).toBe(1);
    expect(store.sync).toMatchObject({ listedCount: 4, listedAt: later });
    expect(store.sync!.problem).toBe("CounterAudit answered 503 when listing the review log's packets");
  });

  it("refuses a log whose signed head went back below the one already reached, and keeps that head", async () => {
    const records = [...genesis(), decision("bob", { decision: "reject", reason: "related payer" }), decision("alice")];
    expect(await runReview(["sync"], fakeIO({}, counterAudit(records)).io)).toBe(0);
    expect(store.sync!.checkpointSequence).toBe(4);

    const restored = fakeIO({}, counterAudit(records.slice(0, 3)));
    expect(await runReview(["sync"], restored.io)).toBe(1);
    expect(restored.printed()).toContain(
      "Stopped: CounterAudit's signed checkpoint is at sequence 2, below sequence 4, which the review log has already reached: its head went back."
    );
    expect(store.sync).toMatchObject({ checkpointSequence: 4, checkpointEntryHash: hashOf(4) });
  });

  it("needs the review organization and the Bureau's read key", async () => {
    vi.stubEnv("COUNTERAUDIT_REVIEW_READ_KEY", "");
    const { io, printed } = fakeIO();
    expect(await runReview(["sync"], io)).toBe(2);
    expect(printed()).toBe("Not set: COUNTERAUDIT_REVIEW_READ_KEY. See docs/two-person-review.md.");
    expect(db.schemaReady).not.toHaveBeenCalled();
  });
});

describe("pnpm review head", () => {
  const records = () => [...genesis(), decision("bob", { decision: "reject", reason: "related payer" }), decision("alice")];

  it("states CounterAudit's signed head beside the Bureau's recorded one", async () => {
    const first = fakeIO({}, counterAudit(records().slice(0, 3)));
    expect(await runReview(["head"], first.io)).toBe(0);
    expect(first.printed()).toBe(
      [
        `CounterAudit's signed head: sequence 2, entry hash ${hashOf(2)}, packet ${idOf(2)}, issued 2026-11-03T12:00:00.000Z. Signature checked against the pinned export key, and attested as the head now over this read's own nonce.`,
        "The Bureau's recorded head: none (no database here, or no read has reached a checkpoint yet).",
      ].join("\n")
    );

    expect(await runReview(["sync"], fakeIO({}, counterAudit(records())).io)).toBe(0);
    const behind = fakeIO({}, counterAudit(records().slice(0, 3)));
    expect(await runReview(["head"], behind.io)).toBe(1);
    expect(behind.printed()).toContain(`The Bureau's recorded head: sequence 4, entry hash ${hashOf(4)}.`);
    expect(behind.printed()).toContain("WENT BACK: CounterAudit's head is below the one the Bureau has already reached.");
  });

  it("checks a head pinned in COUNTERAUDIT_REVIEW_MIN_HEAD", async () => {
    vi.stubEnv("COUNTERAUDIT_REVIEW_MIN_HEAD", `2:${hashOf(2)}`);
    const at = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], at.io)).toBe(0);
    expect(at.printed()).toContain("At or past COUNTERAUDIT_REVIEW_MIN_HEAD (sequence 2).");

    vi.stubEnv("COUNTERAUDIT_REVIEW_MIN_HEAD", `6:${hashOf(6)}`);
    const behind = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], behind.io)).toBe(1);
    expect(behind.printed()).toContain("BEHIND: CounterAudit's head is below COUNTERAUDIT_REVIEW_MIN_HEAD (sequence 6).");

    vi.stubEnv("COUNTERAUDIT_REVIEW_MIN_HEAD", `4:${hashOf(99)}`);
    const other = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], other.io)).toBe(1);
    expect(other.printed()).toContain("DIFFERS: CounterAudit's head names another packet at sequence 4 than COUNTERAUDIT_REVIEW_MIN_HEAD.");

    vi.stubEnv("COUNTERAUDIT_REVIEW_MIN_HEAD", "4");
    const malformed = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], malformed.io)).toBe(2);
    expect(malformed.printed()).toBe('COUNTERAUDIT_REVIEW_MIN_HEAD is not "sequence:entryhash".');
  });

  it("states the Bureau organization's head where it can be read, and checks COUNTERAUDIT_MIN_HEAD", async () => {
    vi.stubEnv("COUNTERAUDIT_ORG_ID", "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1");
    vi.stubEnv("COUNTERAUDIT_READ_KEY", "ca_read_bureau");
    const open = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], open.io)).toBe(0);
    expect(open.printed()).toContain(`The Bureau organization's signed head: sequence 4, entry hash ${hashOf(4)}.`);

    vi.stubEnv("COUNTERAUDIT_MIN_HEAD", `2:${hashOf(2)}`);
    const at = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], at.io)).toBe(0);
    expect(at.printed()).toContain("At or past COUNTERAUDIT_MIN_HEAD (sequence 2).");

    vi.stubEnv("COUNTERAUDIT_MIN_HEAD", `6:${hashOf(6)}`);
    const behind = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], behind.io)).toBe(1);
    expect(behind.printed()).toContain("BEHIND: the Bureau organization's head is below COUNTERAUDIT_MIN_HEAD (sequence 6).");

    vi.stubEnv("COUNTERAUDIT_MIN_HEAD", `4:${hashOf(99)}`);
    const other = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], other.io)).toBe(1);
    expect(other.printed()).toContain("DIFFERS: the Bureau organization's head names another packet at sequence 4 than COUNTERAUDIT_MIN_HEAD.");

    vi.stubEnv("COUNTERAUDIT_MIN_HEAD", "4");
    const malformed = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], malformed.io)).toBe(2);
    expect(malformed.printed()).toBe('COUNTERAUDIT_MIN_HEAD is not "sequence:entryhash".');

    // Without the Bureau's read key it cannot compare, and says so.
    vi.stubEnv("COUNTERAUDIT_MIN_HEAD", `2:${hashOf(2)}`);
    vi.stubEnv("COUNTERAUDIT_READ_KEY", "");
    const keyless = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], keyless.io)).toBe(0);
    expect(keyless.printed()).toContain("COUNTERAUDIT_MIN_HEAD not compared");
  });

  it("does not take a database that is set but not ready for one with no head recorded", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://bureau@127.0.0.1/bureau");
    db.schemaReady.mockResolvedValueOnce(false);
    const down = fakeIO({}, counterAudit(records()));
    expect(await runReview(["head"], down.io)).toBe(1);
    expect(down.printed()).toContain("NOT CHECKED: DATABASE_URL is set, but the Bureau's recorded head could not be read");
    expect(down.printed()).not.toContain("The Bureau's recorded head: none");
  });

  it("stops at a checkpoint that is not signed with CounterAudit's key", async () => {
    const forged = fakeIO({}, async () => Response.json({ checkpoint: { checkpoint_type: "counteraudit.chain_checkpoint" } }));
    expect(await runReview(["head"], forged.io)).toBe(1);
    expect(forged.printed()).toMatch(/^Stopped: the review log's checkpoint is not signed with CounterAudit's export key/);
  });
});

describe("pnpm review queue and settle", () => {
  it("names what a payment line's evidence proved, and what it does not", async () => {
    store.rows.push(row({ evidenceStatus: "verified", outcome: "paid" }));
    const { io, printed } = fakeIO();
    expect(await runReview(["queue"], io)).toBe(0);
    const out = printed();
    expect(out).toContain("evidence payment_settlement_verified");
    expect(out).not.toMatch(/evidence verified\b/);
    expect(out).toContain(
      "subject_control unproven; payer_independence_screen not run"
    );
    expect(out).toContain(
      "a settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered"
    );
  });

  it("labels evidence by outcome", () => {
    expect(evidenceLabel("paid", "verified")).toBe("payment_settlement_verified");
    expect(evidenceLabel("refunded", "verified")).toBe("payment_settlement_verified");
    expect(evidenceLabel("payment_failed", "verified")).toBe("payment_failure_verified");
    expect(evidenceLabel("delivered", "verified")).toBe("verified");
    expect(evidenceLabel("paid", "needs_review")).toBe("needs_review");
    expect(evidenceLabel("paid", null)).toBe("not checked");
  });

  it("labels evidence from the result reviewers sign, and holds a line whose column disagrees", async () => {
    store.rows.push(
      row({
        evidenceStatus: "verified",
        evidenceResult: { status: "needs_review", reasons: ["no machine check exists for delivered outcomes"] },
        outcome: "delivered",
      })
    );
    seal(...genesis());
    const { io, printed } = fakeIO();

    expect(await runReview(["queue"], io)).toBe(0);
    const out = printed();
    expect(out).toContain("evidence not checked: no machine check exists for delivered outcomes");
    expect(out).toContain(
      "review: its evidenceStatus does not match the evidence result reviewers sign; run the intake again"
    );
  });

  it("lists each open line with its hash, its sealed decisions and what holds it back", async () => {
    store.rows.push(
      row({
        evidenceStatus: "needs_review",
        evidenceResult: {
          status: "needs_review",
          reasons: ["no machine check exists for delivered outcomes"],
        },
        outcome: "delivered",
      }),
      row({ id: 2, eventId: "gone", displayState: "withdrawn" }),
      row({
        id: 3,
        eventId: "withdrawal",
        relationType: "withdraws",
        relationTargetEventId: "gone",
      })
    );
    seal(...genesis(), decision("alice"));
    const { io, printed } = fakeIO();

    expect(await runReview(["queue"], io)).toBe(0);
    const out = printed();
    expect(out).toContain("Review log read to sequence 3.");
    expect(out).toContain(
      `${LINE}  delivered  test data  shown unverified`
    );
    expect(out).toContain(`  hash ${HASH}`);
    expect(out).toContain(
      "evidence needs_review: no machine check exists for delivered outcomes"
    );
    // Alice approved without waiving the evidence, so it does not count.
    expect(out).toContain(`  sealed: rev_alice approve at sequence 3 (packet ${idOf(3)})`);
    expect(out).toContain(
      "review: needs 2 more approvals that waive the evidence from different reviewers (test data: one is enough)"
    );
    expect(out).toContain(
      "3 lines: 2 waiting, 0 released, 1 withdrawn or superseded."
    );
    expect(out).not.toContain("fur_levymerchant1/gone ");
    expect(out).toContain(
      `  sign with: --line ${LINE} --hash ${HASH} --data-class test --evidence ${evidenceDigest({ status: "needs_review", reasons: ["no machine check exists for delivered outcomes"] })}`
    );
  });

  it("says where the review log stands against CounterAudit: never synced, up to date, behind, stopped, stale", async () => {
    const queued = async () => {
      const f = fakeIO();
      await runReview(["queue"], f.io);
      return f.printed();
    };
    expect(await queued()).toContain("Sync status: no pnpm review sync has run yet.");

    await runReview(["sync"], fakeIO({}, counterAudit([...genesis(), decision("alice")])).io);
    let printed = await queued();
    expect(printed).toContain(
      "Sync status: last run 2026-10-31T12:00:00.000Z (under an hour ago); last that read the whole log 2026-10-31T12:00:00.000Z (under an hour ago)."
    );
    expect(printed).toContain("CounterAudit's head: 4 packets listed (sequence 3) at 2026-10-31T12:00:00.000Z; 4 held here.");
    expect(printed).toContain("Up to date as of the last sync.");

    // CounterAudit lists more than was read, and the last sync stopped there.
    store.sync = { ...store.sync!, listedCount: 6, problem: "the chain breaks between sequence 3 and 5; read up to 3" };
    printed = await queued();
    expect(printed).toContain("STOPPED at the last sync: the chain breaks between sequence 3 and 5; read up to 3.");
    expect(printed).toContain("BEHIND: 2 listed packets not read here.");
    expect(printed).not.toContain("Up to date");

    // A day without a sync that read the whole log.
    store.sync = { ...store.sync!, problem: null, listedCount: 4, lastSuccessAt: new Date(NOW.getTime() - 25 * 3_600_000) };
    expect(await queued()).toContain("STALE: no sync has read the whole log in the last 24 hours; run pnpm review sync.");
  });

  it("passes over a line erased with its source, and counts it", async () => {
    store.rows.push(
      row({
        id: 4,
        eventId: "expired",
        subjectRef: null,
        evidenceResult: null,
        expiredAt: new Date("2028-10-31T03:15:00.000Z"),
      })
    );
    const { io, printed } = fakeIO();
    expect(await runReview(["queue"], io)).toBe(0);
    expect(printed()).not.toContain("fur_levymerchant1/expired ");
    expect(printed()).toContain(
      "1 line: 0 waiting, 0 released, 0 withdrawn or superseded, 1 expired with their source."
    );
  });

  it("counts nothing while no genesis is pinned", async () => {
    pin.genesis = null;
    store.rows.push(row());
    seal(...genesis(), decision("alice"));
    const { io, printed } = fakeIO();
    await runReview(["settle"], io);
    expect(store.rows[0].displayState).toBe("unverified");
    await runReview(["queue"], io);
    expect(printed()).toContain(
      "No genesis has taken effect, so no decision counts. None is pinned yet (REVIEW_GENESIS in server/reviewLog.ts)."
    );
  });

  it("counts no decision until a genesis takes effect", async () => {
    store.rows.push(row());
    seal(...genesis().slice(0, 2), decision("alice"));
    const { io, printed } = fakeIO();
    expect(await runReview(["queue"], io)).toBe(0);
    expect(printed()).toContain("No genesis has taken effect, so no decision counts.");
    expect(printed()).not.toContain("released (");
  });

  it("re-settles every line, so a reviewer two others remove stops counting", async () => {
    store.rows.push(row());
    seal(...genesis(), decision("alice"));
    await runReview(["settle"], fakeIO().io);
    expect(store.rows[0].displayState).toBe("released");

    const remove: KeyChange = { type: "remove", reviewer_id: "rev_alice" };
    seal(keyRecord("bob", remove), keyRecord("carol", remove));
    const after = fakeIO();
    expect(await runReview(["settle"], after.io)).toBe(0);
    expect(store.rows[0].displayState).toBe("unverified");
    expect(after.printed()).toContain(`${LINE}: released -> unverified`);
  });

  it("holds a released line once one of its approvers is suspended", async () => {
    store.rows.push(row({ dataClass: "live", ...signedBy }));
    seal(
      ...genesis(),
      admission("alice"),
      admission("carol"),
      decision("alice", { data_class: "live" }),
      decision("bob", { data_class: "live" })
    );
    await runReview(["settle"], fakeIO().io);
    expect(store.rows[0].displayState).toBe("released");

    seal(keyRecord("carol", { type: "suspend", reviewer_id: "rev_bob" }));
    const { io, printed } = fakeIO();
    await runReview(["settle"], io);
    expect(store.rows[0].displayState).toBe("unverified");
    await runReview(["queue"], io);
    expect(printed()).toContain("by a suspended reviewer");
    expect(printed()).toContain(
      "review: rev_bob decided on it and is suspended; held until the other reviewers re-enable, rotate or remove them"
    );
  });
});

describe("what pnpm review trusts", () => {
  it("never counts a stored record whose signature does not check out", async () => {
    store.rows.push(row({ dataClass: "live" }));
    const signed = decision("alice", { data_class: "live" });
    // Someone with database access copies Alice's decision in as Bob's.
    seal(...genesis(), signed, { ...signed, reviewer_id: "rev_bob" }, "not json");
    await runReview(["settle"], fakeIO().io);
    expect(store.rows[0].displayState).toBe("unverified");
  });

  it("stops counting decisions signed with a key since rotated", async () => {
    store.rows.push(row());
    seal(...genesis(), decision("alice"));
    await runReview(["settle"], fakeIO().io);
    expect(store.rows[0].displayState).toBe("released");

    const rotate: KeyChange = { type: "rotate", reviewer_id: "rev_alice", public_key: newReviewerKey().publicKey };
    seal(keyRecord("bob", rotate), keyRecord("carol", rotate));
    await runReview(["settle"], fakeIO().io);
    expect(store.rows[0].displayState).toBe("unverified");
  });

  it("counts nothing past a packet missing from the stored copy", async () => {
    store.rows.push(row());
    seal(...genesis(), decision("bob", { decision: "reject", reason: "related payer" }), decision("alice"));
    // Someone with database access deletes Bob's rejection.
    store.log.splice(3, 1);
    const { io, printed } = fakeIO();
    await runReview(["settle"], io);
    expect(store.rows[0].displayState).toBe("unverified");
    await runReview(["queue"], io);
    expect(printed()).toContain("Review log read to sequence 2.");
  });

  it("no longer takes decisions handed to the operator", async () => {
    const { io, printed } = fakeIO({ "d.jsonl": JSON.stringify(decision("alice")) });
    expect(await runReview(["apply", "d.jsonl"], io)).toBe(2);
    expect(printed()).toContain("pnpm review apply is retired");
    expect(db.schemaReady).not.toHaveBeenCalled();
  });
});

describe("pnpm review admit, revoke-admission and admissions", () => {
  const admitArgs = (...extra: string[]) => [
    "admit",
    "--key",
    "alice.pem",
    "--reviewer",
    "rev_alice",
    "--furnisher",
    "fur_levymerchant1",
    ...extra,
    "--out",
    "a.json",
  ];

  it("signs an admission of an unlisted furnisher for the organization and key named", async () => {
    const { io, written, printed } = fakeIO(keys());
    const args = admitArgs("--org", FURNISHER_ORG, "--furnisher-key", `levy-1=${FURNISHER_KEY}`, "--probation-days", "120");
    expect(await runReview(args, io)).toBe(0);
    // Ed25519 signatures are deterministic: the same record signs the same.
    expect(JSON.parse(written["a.json"])).toEqual(admission("alice", { probation_days: 120, decided_at: NOW.toISOString() }));
    expect(printed()).toContain("you attest it was vetted and deals at arm's length");
    expect(printed()).toContain("Seal it with: pnpm review submit a.json");
    expect(db.schemaReady).not.toHaveBeenCalled();
  });

  it("takes a listed furnisher's organization and active keys from server/furnishers.ts", async () => {
    const second = newReviewerKey().publicKey;
    const { io, written, printed } = fakeIO(keys());
    io.furnishers = {
      fur_levymerchant1: {
        counterauditOrgId: FURNISHER_ORG,
        keys: {
          "levy-2": { publicKey: second, status: "active" },
          "levy-1": { publicKey: FURNISHER_KEY, status: "active" },
          "levy-0": { publicKey: newReviewerKey().publicKey, status: "revoked" },
        },
      },
    };
    expect(await runReview(admitArgs(), io)).toBe(0);
    expect(JSON.parse(written["a.json"]).keys).toEqual([
      { key_id: "levy-1", public_key: FURNISHER_KEY },
      { key_id: "levy-2", public_key: second },
    ]);
    expect(await runReview(admitArgs("--org", FURNISHER_ORG), io)).toBe(2);
    expect(printed()).toContain("--org and --furnisher-key are for an unlisted furnisher");
  });

  it("signs nothing it cannot sign as asked", async () => {
    const cases: [string[], string][] = [
      [admitArgs(), "name the organization it seals in with --org"],
      [admitArgs("--org", FURNISHER_ORG, "--furnisher-key", FURNISHER_KEY), "--furnisher-key <key_id>=<ed25519:...>"],
      [admitArgs("--org", FURNISHER_ORG, "--furnisher-key", `levy-1=${FURNISHER_KEY}`, "--probation-days", "30"), "Not signed: probation_days must be a whole number from 90 to 365."],
      [admitArgs("--org", FURNISHER_ORG, "--furnisher-key", `levy-1=${FURNISHER_KEY}`, "--probation-days", "1e2"), "--probation-days must be a whole number"],
      [admitArgs("--org", "not-an-org", "--furnisher-key", `levy-1=${FURNISHER_KEY}`), "Not signed: counteraudit_org_id must be"],
    ];
    for (const [args, message] of cases) {
      const { io, written, printed } = fakeIO(keys());
      expect(await runReview(args, io), message).toBe(2);
      expect(printed()).toContain(message);
      expect(written).toEqual({});
    }
  });

  it("signs a revocation with its reason, and only with one", async () => {
    const { io, written, printed } = fakeIO(keys());
    const args = ["revoke-admission", "--key", "bob.pem", "--reviewer", "rev_bob", "--furnisher", "fur_levymerchant1"];
    expect(await runReview([...args, "--out", "r.json"], io)).toBe(2);
    expect(await runReview([...args, "--reason", "pays its own subjects", "--out", "r.json"], io)).toBe(0);
    expect(JSON.parse(written["r.json"])).toMatchObject({
      schema: ADMISSION_SCHEMA,
      reviewer_id: "rev_bob",
      decision: "revoke",
      reason: "pays its own subjects",
    });
    expect(printed()).toContain("none of its live lines is released until two reviewers admit it again");
  });

  it("seals an admission like any other review record", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ packet_id: idOf(3), sequence: 3, receipt: {} }, { status: 201 })
    );
    const signed = admission("alice");
    const { io } = fakeIO({ "a.json": JSON.stringify(signed) }, fetch);
    expect(await runReview(["submit", "a.json"], io)).toBe(0);
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body)).raw_event).toEqual(signed);
  });

  it("lists each furnisher's admission, and shows it on each live line in the queue", async () => {
    store.rows.push(row({ dataClass: "live", ...signedBy }));
    seal(...genesis(), admission("alice"), admission("bob"));
    const until = new Date(NOW.getTime() + 90 * 24 * 3_600_000).toISOString();
    const first = fakeIO();
    expect(await runReview(["admissions"], first.io)).toBe(0);
    expect(first.printed()).toContain(
      [
        `fur_levymerchant1: admitted at sequence 4 by rev_alice and rev_bob, since ${NOW.toISOString()}; on probation until ${until}`,
        `  organization ${FURNISHER_ORG}`,
        `  key levy-1 ${FURNISHER_KEY}`,
      ].join("\n")
    );
    expect(await runReview(["queue"], first.io)).toBe(0);
    expect(first.printed()).toContain(
      `  furnisher admitted, and the line was sealed during its probation (until ${until}): no approval can waive anything for it`
    );

    seal(
      signAdmission(
        {
          schema: ADMISSION_SCHEMA,
          reviewer_id: "rev_carol",
          furnisher_id: "fur_levymerchant1",
          decision: "revoke",
          reason: "pays its own subjects",
          decided_at: "2026-10-31T11:30:00.000Z",
        },
        people.carol.privateKeyPem
      )
    );
    const after = fakeIO();
    await runReview(["admissions"], after.io);
    expect(after.printed()).toContain('fur_levymerchant1: revoked at sequence 5 by rev_carol: "pays its own subjects"');
    await runReview(["queue"], after.io);
    expect(after.printed()).toContain(
      "  furnisher not admitted for this line: its furnisher's admission was revoked by rev_carol at sequence 5"
    );
  });

  it("says when no furnisher is admitted", async () => {
    seal(...genesis());
    const { io, printed } = fakeIO();
    expect(await runReview(["admissions"], io)).toBe(0);
    expect(printed()).toContain("No furnisher is admitted, so no live line is released.");
  });
});

describe("moving to a new review organization", () => {
  const NEW_ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const NEW_TEAM = TEAM.map(r => ({ ...r, name: `${r.name} (independent)` }));
  const newGenesis = () =>
    (["alice", "bob", "carol"] as const).map(p => keyRecord(p, { type: "genesis", reviewers: NEW_TEAM }));
  const inNewOrg = (records: unknown[], skip: number[] = []) =>
    counterAudit(records, skip, { org: NEW_ORG, base: 1000 });
  const REJECTION = () => decision("bob", { decision: "reject", reason: "related payer" });

  // The Bureau's copy as a sync of the old organization left it.
  async function onOldOrg(records: unknown[]) {
    expect(await runReview(["sync"], fakeIO({}, counterAudit(records)).io)).toBe(0);
    expect(store.sync!.orgId).toBe(ORG);
  }
  const toNewOrg = () => {
    pin.genesis = genesisHash(NEW_TEAM);
    vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", NEW_ORG);
  };

  describe("the copy holds one organization's log", () => {
    it("records the organization at the first read that reaches the whole log", async () => {
      expect(await runReview(["sync"], fakeIO({}, counterAudit(genesis())).io)).toBe(0);
      expect(store.sync!.orgId).toBe(ORG);
    });

    it("does not record it from a read that stopped", async () => {
      expect(await runReview(["sync"], fakeIO({}, counterAudit(genesis(), [1])).io)).toBe(1);
      expect(store.sync!.orgId ?? null).toBeNull();
    });

    it("refuses another organization before reading anything from it", async () => {
      await onOldOrg(genesis());
      const before = { log: [...store.log], head: store.sync!.checkpointSequence };
      vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", NEW_ORG);
      const fetch = inNewOrg([...newGenesis(), decision("alice")]);
      const { io, printed } = fakeIO({}, fetch);

      expect(await runReview(["sync"], io)).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(printed()).toContain(`Stopped: the Bureau's copy of the review log is organization ${ORG}'s, not ${NEW_ORG}`);
      expect(printed()).toContain("pnpm review move");
      expect(store.log).toEqual(before.log);
      expect(store.sync!.checkpointSequence).toBe(before.head);
      expect(store.sync!.orgId).toBe(ORG);
    });

    it("still refuses another organization's packets when no organization is recorded yet", async () => {
      // A copy from before the organization was recorded.
      seal(...genesis());
      vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", NEW_ORG);
      const { io, printed } = fakeIO({}, inNewOrg(newGenesis()));
      expect(await runReview(["sync"], io)).toBe(1);
      expect(printed()).toContain("two packets claim sequence 0");
      expect(store.sync!.orgId ?? null).toBeNull();
    });

    it("says so in pnpm review head, rather than comparing another organization's head", async () => {
      await onOldOrg(genesis());
      vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", NEW_ORG);
      const { io, printed } = fakeIO({}, inNewOrg(newGenesis()));
      expect(await runReview(["head"], io)).toBe(1);
      expect(printed()).toContain(`NOT CHECKED: the Bureau's copy of the review log is organization ${ORG}'s`);
      expect(printed()).not.toContain("WENT BACK");
    });

    it("names the organization in the queue", async () => {
      await onOldOrg(genesis());
      const { io, printed } = fakeIO();
      expect(await runReview(["queue"], io)).toBe(0);
      expect(printed()).toContain(`Review organization: ${ORG}.`);
    });
  });

  describe("pnpm review move", () => {
    it("moves the copy once a new genesis is pinned and has taken effect in the new organization", async () => {
      store.rows.push(row());
      await onOldOrg([...genesis(), REJECTION()]);
      expect(store.rows[0].displayState).not.toBe("released");
      const oldHead = { sequence: store.sync!.checkpointSequence, entryHash: store.sync!.checkpointEntryHash };
      toNewOrg();

      const { io, printed } = fakeIO({}, inNewOrg([...newGenesis(), decision("alice")]));
      expect(await runReview(["move"], io)).toBe(0);

      expect(store.log.map(r => r.packetId)).toEqual([0, 1, 2, 3].map(n => idOf(1000 + n)));
      expect(store.sync).toMatchObject({
        orgId: NEW_ORG,
        problem: null,
        lastSuccessAt: NOW,
        listedCount: 4,
        checkpointSequence: 3,
        checkpointEntryHash: hashOf(1003),
      });
      expect(store.moves).toEqual([
        {
          fromOrgId: ORG,
          toOrgId: NEW_ORG,
          fromPackets: 4,
          fromCheckpointSequence: oldHead.sequence,
          fromCheckpointEntryHash: oldHead.entryHash,
          pinnedGenesis: genesisHash(NEW_TEAM),
          movedAt: NOW,
        },
      ]);
      // Lines are settled by the new log straight away.
      expect(store.rows[0].displayState).toBe("released");
      expect(printed()).toContain(`Moved the Bureau's copy of the review log from organization ${ORG} to ${NEW_ORG}`);
      expect(printed()).toContain(`COUNTERAUDIT_REVIEW_MIN_HEAD to 3:${hashOf(1003)}`);

      // And from here a sync reads the new organization.
      const again = fakeIO({}, inNewOrg([...newGenesis(), decision("alice")]));
      expect(await runReview(["sync"], again.io)).toBe(0);
      expect(again.printed()).toContain("Read 0 new packets.");
    });

    it("cannot swap a log for one that leaves out a rejection while its genesis is still pinned", async () => {
      store.rows.push(row());
      const rejected = [...genesis(), REJECTION()];
      await onOldOrg(rejected);
      const held = [...store.log];
      // Every reviewer's key signs the same genesis again in another organization, with no rejection.
      vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", NEW_ORG);
      const { io, printed } = fakeIO({}, inNewOrg([...genesis(), decision("alice")]));

      expect(await runReview(["move"], io)).toBe(1);
      expect(printed()).toContain("Not moved: the pinned genesis has taken effect in the log held here");
      expect(printed()).toContain("REVIEW_GENESIS");
      expect(db.moveReviewLog).not.toHaveBeenCalled();
      expect(store.log).toEqual(held);
      expect(store.sync!.orgId).toBe(ORG);
      expect(store.rows[0].displayState).not.toBe("released");
    });

    it("refuses an organization where the pinned genesis has not taken effect", async () => {
      await onOldOrg(genesis());
      toNewOrg();
      // Two of the three have signed.
      const { io, printed } = fakeIO({}, inNewOrg(newGenesis().slice(0, 2)));
      expect(await runReview(["move"], io)).toBe(1);
      expect(printed()).toContain(`Not moved: the pinned genesis has not taken effect in organization ${NEW_ORG}'s review log`);
      expect(db.moveReviewLog).not.toHaveBeenCalled();
      expect(store.sync!.orgId).toBe(ORG);
    });

    it("refuses signatures replayed into another organization a day later", async () => {
      // A copy holding nothing that counts, and the pinned genesis copied from elsewhere.
      seal(keyRecord("alice", { type: "genesis", reviewers: NEW_TEAM }));
      pin.genesis = genesisHash(TEAM);
      vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", NEW_ORG);
      const later = new Date(NOW.getTime() + 2 * 24 * 3_600_000);
      const fetch = counterAudit(genesis(), [], { org: NEW_ORG, base: 1000, sealedAt: later });
      const { io, printed } = fakeIO({}, fetch);
      expect(await runReview(["move"], io)).toBe(1);
      expect(printed()).toContain("has not taken effect");
      expect(db.moveReviewLog).not.toHaveBeenCalled();
    });

    it("refuses a new organization's log it cannot read whole", async () => {
      await onOldOrg(genesis());
      toNewOrg();
      const { io, printed } = fakeIO({}, inNewOrg([...newGenesis(), decision("alice")], [1]));
      expect(await runReview(["move"], io)).toBe(1);
      expect(printed()).toContain(`Not moved: organization ${NEW_ORG}'s review log could not be read whole`);
      expect(db.moveReviewLog).not.toHaveBeenCalled();

      const down = fakeIO({}, async () => new Response(null, { status: 503 }));
      expect(await runReview(["move"], down.io)).toBe(1);
      expect(db.moveReviewLog).not.toHaveBeenCalled();
    });

    it("has nothing to do when the copy is already that organization's", async () => {
      await onOldOrg(genesis());
      pin.genesis = genesisHash(NEW_TEAM);
      const { io, printed } = fakeIO({}, counterAudit(genesis()));
      expect(await runReview(["move"], io)).toBe(1);
      expect(printed()).toContain("already organization");
      expect(db.moveReviewLog).not.toHaveBeenCalled();
    });

    it("moves a copy from before the organization was recorded", async () => {
      seal(...genesis());
      toNewOrg();
      const { io, printed } = fakeIO({}, inNewOrg(newGenesis()));
      expect(await runReview(["move"], io)).toBe(0);
      expect(store.moves[0]).toMatchObject({ fromOrgId: null, toOrgId: NEW_ORG, fromPackets: 3 });
      expect(store.sync!.orgId).toBe(NEW_ORG);
      expect(printed()).toContain("from organization not recorded");
    });

    it("holds a return to an organization to the head the copy had reached there", async () => {
      const oldLog = [...genesis(), decision("alice"), REJECTION()];
      await onOldOrg(oldLog);
      toNewOrg();
      expect(await runReview(["move"], fakeIO({}, inNewOrg(newGenesis())).io)).toBe(0);

      // The pin goes back, and the old organization has been restored from a backup.
      pin.genesis = genesisHash(TEAM);
      vi.stubEnv("COUNTERAUDIT_REVIEW_ORG_ID", ORG);
      const restored = fakeIO({}, counterAudit(oldLog.slice(0, 3)));
      expect(await runReview(["move"], restored.io)).toBe(1);
      expect(restored.printed()).toContain("its head went back");
      expect(store.sync!.orgId).toBe(NEW_ORG);

      // The whole log is taken back, and the head it had reached stands again.
      expect(await runReview(["move"], fakeIO({}, counterAudit(oldLog)).io)).toBe(0);
      expect(store.sync).toMatchObject({ orgId: ORG, checkpointSequence: 4, checkpointEntryHash: hashOf(4) });
    });

    it("needs the review organization and the Bureau's read key, and takes no arguments", async () => {
      expect(await runReview(["move", "--to", NEW_ORG], fakeIO().io)).toBe(2);
      vi.stubEnv("COUNTERAUDIT_REVIEW_READ_KEY", "");
      expect(await runReview(["move"], fakeIO().io)).toBe(2);
    });
  });
});
