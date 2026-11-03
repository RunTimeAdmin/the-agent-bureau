// pnpm file assemble against the review log as CounterAudit holds it now (review M-01): a
// rejection sealed since the last pnpm review sync must hold its line on the next file, and a
// file is not signed against a log the Bureau could not read to its head. Also each line against
// its source's retention date: checkable until then, and expired, not failed, once erased.
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getReviewLogHead: vi.fn(async () => null),
  recordReviewLogCheckpoint: vi.fn(async () => {}),
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

import { runFile, signFile, type FileIO, type SignedAgentFile } from "./agentFile";
import type { ProofResult } from "./counteraudit";
import { canonicalizeJson, signedEventHash } from "./outcomeProof";
import {
  REVIEW_SCHEMA,
  evidenceDigest,
  newReviewerKey,
  signReviewDecision,
} from "./reviewDecision";
import { REVIEWER_KEY_SCHEMA, genesisHash, signKeyRecord } from "./reviewLog";
import { ADMISSION_SCHEMA, signAdmission } from "./furnisherAdmission";
import type { EvidenceResult } from "./evidence";
import { evidenceRecordFor, type EvidenceRecord } from "./evidenceSeal";

// The review log's checkpoints in these fakes are signed with a key made for the test run
// (server/testCheckpoint.ts); the pinned keys gain it in this file only.
vi.mock("./counterauditKeys", async importOriginal => {
  const actual = await importOriginal<typeof import("./counterauditKeys")>();
  const { TEST_EXPORT_KEY } = await import("./testCheckpoint");
  return { COUNTERAUDIT_EXPORT_KEYS: { keys: [...actual.COUNTERAUDIT_EXPORT_KEYS.keys, TEST_EXPORT_KEY] } };
});
import { checkpointResponse } from "./testCheckpoint";


const NOW = new Date("2026-11-01T12:00:00.000Z");
const API = "https://api.counteraudit.test";
const REVIEW_ORG = "11111111-2222-4333-8444-555555555555";
const BUREAU_ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
const WALLET = "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77";
const EVIDENCE = { status: "verified", reasons: [] };
const people = {
  alice: newReviewerKey(),
  bob: newReviewerKey(),
  carol: newReviewerKey(),
};
type Person = keyof typeof people;
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

// One stored line, read from its signed event, signed with the pilot furnisher's key.
const pilot = newReviewerKey();
const unsignedEvent = {
  schema_version: "1",
  furnisher_id: "fur_bureaupilot01",
  key_id: "pilot-2026-10",
  event_id: "event-1",
  subject_ref: { wallet: WALLET },
  occurred_at: "2026-10-31T10:00:00.000Z",
  outcome: "delivered",
};
const event = {
  ...unsignedEvent,
  signature: `ed25519:${sign(null, Buffer.from(`agent-bureau/outcome-event/v1\n${canonicalizeJson(unsignedEvent)}`, "utf8"), createPrivateKey(pilot.privateKeyPem)).toString("base64url")}`,
};
const LINE = {
  id: 1,
  furnisherId: event.furnisher_id,
  eventId: event.event_id,
  subjectRef: event.subject_ref,
  dataClass: "test" as const,
  proofOk: true,
  evidenceStatus: "verified",
  evidenceResult: EVIDENCE,
  evidenceKey: null,
  signedEventHash: signedEventHash(event),
  displayState: "unverified",
  relationType: null,
  relationTargetEventId: null,
  outcome: event.outcome,
  occurredAt: new Date(event.occurred_at),
  receivedAt: new Date("2026-10-31T11:00:00.000Z"),
  caCreatedAt: new Date("2026-10-31T11:00:01.000Z"),
  packetId: "29879d36-0000-4000-8000-000000000001",
  entryHash: "e".repeat(64),
  sequence: 7,
  signedEvent: event,
};

const genesis = () =>
  (["alice", "bob", "carol"] as const).map(p =>
    signKeyRecord(
      {
        schema: REVIEWER_KEY_SCHEMA,
        signer_id: `rev_${p}`,
        change: { type: "genesis", reviewers: TEAM },
        decided_at: "2026-11-01T09:00:00.000Z",
      },
      people[p].privateKeyPem
    )
  );
const decision = (
  reviewer: Person,
  verdict: "approve" | "approve_with_waiver" | "reject",
  decidedAt: string,
  dataClass: "test" | "live" = "test"
) =>
  signReviewDecision(
    {
      schema: REVIEW_SCHEMA,
      reviewer_id: `rev_${reviewer}`,
      furnisher_id: LINE.furnisherId,
      event_id: LINE.eventId,
      signed_event_hash: LINE.signedEventHash,
      data_class: dataClass,
      evidence_digest: evidenceDigest(EVIDENCE),
      decision: verdict,
      // A rejection or a waiver is counted only with a reason.
      ...(verdict === "reject"
        ? { reason: "related payer" }
        : verdict === "approve_with_waiver"
          ? { reason: "checked the delivery by hand" }
          : {}),
      decided_at: decidedAt,
    },
    people[reviewer].privateKeyPem
  );

// The pilot furnisher's signing key, and a reviewer's admission of the furnisher with it.
const pilotKey = pilot.publicKey;
const admit = (reviewer: Person, publicKey = pilotKey) =>
  signAdmission(
    {
      schema: ADMISSION_SCHEMA,
      reviewer_id: `rev_${reviewer}`,
      furnisher_id: LINE.furnisherId,
      decision: "admit",
      counteraudit_org_id: BUREAU_ORG,
      keys: [{ key_id: event.key_id, public_key: publicKey }],
      arms_length: true,
      probation_days: 90,
      decided_at: "2026-11-01T09:30:00.000Z",
    },
    people[reviewer].privateKeyPem
  );

// The evidence result sealed for LINE in the Bureau's organization, as the intake seals it.
const BUREAU_READ_KEY = "ca_read_bureau";
const lineSeal = (changes: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  ...evidenceRecordFor(LINE, EVIDENCE as EvidenceResult, new Date("2026-10-31T11:00:00.500Z")),
  ...changes,
});
const sealId = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// CounterAudit's list and verify routes over a review organization holding these records, and,
// for the Bureau's read key, the Bureau's organization holding LINE's packet and these evidence
// records (by default one sealing LINE's result).
function counterAudit(
  records: unknown[],
  options: { skip?: number[]; swap?: Record<number, unknown>; evidence?: unknown[] } = {}
) {
  const chain = records
    .map((record, n) => ({
      packet_id: idOf(n),
      org_id: REVIEW_ORG,
      sequence: n,
      connector_id: "agent-bureau-review-v1",
      signed_event: n in (options.swap ?? {}) ? options.swap![n] : record,
      integrity: { prev_hash: hashOf(n - 1), entry_hash: hashOf(n) },
      created_at: NOW.toISOString(),
    }))
    .filter(p => !(options.skip ?? []).includes(p.sequence));
  const bureau = [
    {
      packet_id: LINE.packetId,
      org_id: BUREAU_ORG,
      sequence: LINE.sequence,
      connector_id: "agent-bureau-outcome-v1",
    },
    ...(options.evidence ?? [lineSeal()]).map((record, n) => ({
      packet_id: sealId(n),
      org_id: BUREAU_ORG,
      sequence: 100 + n,
      connector_id: "agent-bureau-evidence-v1",
      signed_event: record,
      integrity: { prev_hash: hashOf(99 + n), entry_hash: hashOf(100 + n) },
      created_at: NOW.toISOString(),
    })),
  ];
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const packets: { packet_id: string; connector_id: string }[] =
      headers.authorization === `Bearer ${BUREAU_READ_KEY}` ? bureau : chain;
    const checkpointPath = /^\/v1\/audit\/chain\/([^/]+)\/checkpoint$/.exec(path);
    if (checkpointPath) {
      const tip = packets.at(-1) as { sequence: number; packet_id: string; integrity: { entry_hash: string } } | undefined;
      return checkpointResponse(
        checkpointPath[1],
        tip ? { sequence: tip.sequence, entryHash: tip.integrity.entry_hash, packetId: tip.packet_id } : null
      );
    }
    if (path === "/v1/audit/packets") {
      return Response.json({
        packets: [...packets]
          .reverse()
          .map(p => ({ packet_id: p.packet_id, connector_id: p.connector_id, created_at: NOW.toISOString() })),
        next_cursor: null,
      });
    }
    const packet = packets.find(p => path.endsWith(p.packet_id)) as (typeof chain)[number] | undefined;
    if (!packet) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({
      valid: true,
      entry_hash: packet.integrity.entry_hash,
      packet,
    });
  });
}

// CounterAudit's export key, as a test key, and what its public proof route answers for LINE.
const exportKeys = generateKeyPairSync("ed25519");
const JWKS = {
  keys: [
    { ...exportKeys.publicKey.export({ format: "jwk" }), kid: "test-export-1" },
  ],
};
function signExport(
  payload: Record<string, unknown>,
  key = exportKeys.privateKey
) {
  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest();
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
const RETAINED_UNTIL = "2028-10-31T11:00:01.000Z";
const proofFor = (changes: Record<string, unknown> = {}) =>
  signExport({
    proof_type: "counteraudit.packet_proof",
    proof_version: 1,
    packet_id: LINE.packetId,
    org_id: BUREAU_ORG,
    sequence: LINE.sequence,
    entry_hash: LINE.entryHash,
    connector_id: "agent-bureau-outcome-v1",
    created_at: LINE.caCreatedAt.toISOString(),
    public_proof: true,
    content_verified: true,
    outcome_claim: {
      outcome: event.outcome,
      asserted_by: "signature",
      signer: {
        furnisher_id: event.furnisher_id,
        key_id: event.key_id,
        public_key: "ed25519:test",
      },
      signed_event_hash: LINE.signedEventHash,
    },
    expires_at: RETAINED_UNTIL,
    ...changes,
  });
const ERASED_AT = "2028-10-31T03:15:00.000Z";
const tombstoneFor = (
  changes: Record<string, unknown> = {},
  key = exportKeys.privateKey
) =>
  signExport(
    {
      tombstone_type: "counteraudit.packet_tombstone",
      tombstone_version: 1,
      org_id: BUREAU_ORG,
      packet_id: LINE.packetId,
      sequence: LINE.sequence,
      entry_hash: LINE.entryHash,
      expired_at: ERASED_AT,
      commitment: "linkage_only",
      ...changes,
    },
    key
  );
const gone = (tombstone = tombstoneFor()): ProofResult => ({
  ok: false,
  status: 410,
  message: "CounterAudit erased this packet under its retention policy",
  tombstone,
});
const source = { answer: (): ProofResult => ({ ok: true, proof: proofFor() }) };

const fileKey = newReviewerKey();
function fileIO(fetch: FileIO["fetch"]) {
  const out: string[] = [];
  const files: Record<string, string> = { "file.pem": fileKey.privateKeyPem };
  const io: FileIO = {
    readText: async p => {
      if (!(p in files)) throw new Error("no such file");
      return files[p];
    },
    writeNewPrivateFile: async () => {
      throw new Error("not used");
    },
    writeNewFile: async (p, text) => {
      if (p in files) throw new Error("exists");
      files[p] = text;
    },
    log: line => out.push(line),
    now: () => NOW,
    fetchProof: vi.fn(async () => source.answer()),
    fetch,
    jwks: JWKS,
    keys: { "test-file-1": fileKey.publicKey },
    furnishers: {},
    sigvara: {} as FileIO["sigvara"],
  };
  return { io, out, files };
}

const assemble = (io: FileIO, out: string) =>
  runFile(
    [
      "assemble",
      "--subject",
      JSON.stringify({ wallet: WALLET }),
      "--key",
      "file.pem",
      "--key-id",
      "test-file-1",
      "--out",
      out,
    ],
    io
  );

beforeEach(() => {
  source.answer = () => ({ ok: true, proof: proofFor() });
  store.lines = [LINE];
  store.log = [];
  pin.genesis = genesisHash(TEAM);
  process.env.DATABASE_URL = "mysql://test";
  process.env.COUNTERAUDIT_ORG_ID = BUREAU_ORG;
  process.env.COUNTERAUDIT_READ_KEY = BUREAU_READ_KEY;
  process.env.COUNTERAUDIT_REVIEW_ORG_ID = REVIEW_ORG;
  process.env.COUNTERAUDIT_REVIEW_READ_KEY = "ca_read_review";
  process.env.COUNTERAUDIT_API_URL = API;
  delete process.env.COUNTERAUDIT_REVIEW_MIN_HEAD;
});

describe("pnpm file assemble and the review log", () => {
  const approved = () => [
    ...genesis(),
    decision("alice", "approve", "2026-11-01T10:00:00.000Z"),
    decision("bob", "approve", "2026-11-01T10:05:00.000Z"),
  ];

  it("reads the log to CounterAudit's head itself, and states where it stood", async () => {
    // Nothing was synced before: the Bureau's store is empty.
    const { io, files } = fileIO(counterAudit(approved()));
    expect(await assemble(io, "one.json")).toBe(0);
    const file = JSON.parse(files["one.json"]) as SignedAgentFile;
    expect(file.furnished_outcomes).toHaveLength(1);
    expect(file.furnished_outcomes[0].released).toBe("two_person");
    expect(file.review_log).toEqual({
      org_id: REVIEW_ORG,
      sequence: 4,
      entry_hash: hashOf(4),
      packet_id: idOf(4),
    });
    expect(file.furnished_outcomes[0].review_decisions).toEqual([
      { sequence: 3, packet_id: idOf(3), decision: "approve" },
      { sequence: 4, packet_id: idOf(4), decision: "approve" },
    ]);
  });

  it("signs no file with a live line, though two reviewers released it, until counsel's review", async () => {
    // Its furnisher admitted by two reviewers, for the organization and key its receipt names.
    store.lines = [
      {
        ...LINE,
        dataClass: "live" as const,
        receipt: {
          org_id: BUREAU_ORG,
          outcome_claim: { signer: { key_id: event.key_id, public_key: pilotKey } },
        },
      },
    ];
    const released = [
      ...genesis(),
      admit("alice"),
      admit("bob"),
      decision("alice", "approve", "2026-11-01T10:00:00.000Z", "live"),
      decision("bob", "approve", "2026-11-01T10:05:00.000Z", "live"),
    ];
    const { io, files, out } = fileIO(counterAudit(released));
    expect(await assemble(io, "live.json")).toBe(1);
    expect(files["live.json"]).toBeUndefined();
    expect(out.join("\n")).toContain(
      "Not signed: 1 of the lines on this file are live data, and files with live lines are held until counsel has reviewed"
    );
  });

  it("never signs the old release after a rejection sealed since the last sync", async () => {
    const first = fileIO(counterAudit(approved()));
    expect(await assemble(first.io, "one.json")).toBe(0);
    expect(JSON.parse(first.files["one.json"]).furnished_outcomes).toHaveLength(
      1
    );

    // Carol rejects in the review organization. No pnpm review sync runs.
    const records = [
      ...approved(),
      decision("carol", "reject", "2026-11-01T11:00:00.000Z"),
    ];
    const second = fileIO(counterAudit(records));
    expect(await assemble(second.io, "two.json")).toBe(0);
    const file = JSON.parse(second.files["two.json"]) as SignedAgentFile;
    expect(file.furnished_outcomes).toEqual([]);
    expect(file.review_log).toMatchObject({ sequence: 5, packet_id: idOf(5) });
  });

  it("names the evidence seal on each line, and signs nothing over a stored result that is not the one sealed last", async () => {
    const { io, files } = fileIO(counterAudit(approved()));
    expect(await assemble(io, "one.json")).toBe(0);
    const file = JSON.parse(files["one.json"]) as SignedAgentFile;
    expect(file.furnished_outcomes[0].evidence_seal).toEqual({
      org_id: BUREAU_ORG,
      packet_id: sealId(0),
      sequence: 100,
      evidence_digest: evidenceDigest(EVIDENCE),
    });

    // A later check sealed another result, while the store holds the one reviewers approved; or
    // nothing was ever sealed for the line.
    const later = lineSeal({
      evidence_digest: "f".repeat(64),
      status: "needs_review",
      needs_waiver: true,
      checked_at: "2026-11-01T12:00:00.000Z",
    });
    for (const evidence of [[lineSeal(), later], []]) {
      const run = fileIO(counterAudit(approved(), { evidence }));
      expect(await assemble(run.io, "two.json")).toBe(1);
      expect(run.files["two.json"]).toBeUndefined();
      expect(run.out.join("\n")).toContain(
        `${LINE.packetId}: its stored evidence result is not the one CounterAudit sealed last for it`
      );
      expect(run.out.join("\n")).toContain(
        "Not signed: these lines do not check against their signed events or sealed evidence."
      );
    }
  });

  it("signs nothing when the evidence seals cannot be read, and needs the Bureau's read key", async () => {
    const unreadable = fileIO(counterAudit(approved(), { evidence: [{ schema: "something else" }] }));
    expect(await assemble(unreadable.io, "out.json")).toBe(1);
    expect(unreadable.out.join("\n")).toContain(
      `Not signed: the evidence seals could not be read: evidence packet ${sealId(0)} does not hold an evidence record`
    );
    delete process.env.COUNTERAUDIT_READ_KEY;
    const keyless = fileIO(counterAudit(approved()));
    expect(await assemble(keyless.io, "out.json")).toBe(2);
    expect(keyless.out.join("\n")).toContain("COUNTERAUDIT_READ_KEY");
  });

  it("signs nothing when the log cannot be read to its head", async () => {
    const records = [
      ...approved(),
      decision("carol", "reject", "2026-11-01T11:00:00.000Z"),
    ];
    // CounterAudit lists every packet but the Bureau cannot read the rejection.
    const unreadable = fileIO(
      vi.fn(async (url: string) =>
        new URL(url).pathname.endsWith(idOf(5))
          ? new Response(null, { status: 503 })
          : counterAudit(records)(url)
      )
    );
    expect(await assemble(unreadable.io, "out.json")).toBe(1);
    expect(unreadable.files["out.json"]).toBeUndefined();
    expect(unreadable.out.join("\n")).toContain(
      "Not signed: the review log could not be brought up to date"
    );

    // A gap in what CounterAudit answers stops the read there.
    store.log = [];
    const gapped = fileIO(counterAudit(records, { skip: [2] }));
    expect(await assemble(gapped.io, "out.json")).toBe(1);
    expect(gapped.files["out.json"]).toBeUndefined();

    // Unreachable is not an empty log.
    store.log = [];
    const offline = fileIO(
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      })
    );
    expect(await assemble(offline.io, "out.json")).toBe(1);
    expect(offline.out.join("\n")).toContain("ECONNREFUSED");
  });

  it("refuses to run without the review organization's read key", async () => {
    delete process.env.COUNTERAUDIT_REVIEW_READ_KEY;
    const { io, out } = fileIO(counterAudit(approved()));
    expect(await assemble(io, "out.json")).toBe(2);
    expect(out.join("\n")).toContain("COUNTERAUDIT_REVIEW_READ_KEY");
  });
});

describe("pnpm file verify and the review log", () => {
  async function signedFile() {
    const records = [
      ...genesis(),
      decision("alice", "approve", "2026-11-01T10:00:00.000Z"),
      decision("bob", "approve", "2026-11-01T10:05:00.000Z"),
    ];
    const { io, files } = fileIO(counterAudit(records));
    expect(await assemble(io, "one.json")).toBe(0);
    return { records, text: files["one.json"] };
  }

  it("states the position, and checks it and each decision with the read key", async () => {
    const { records, text } = await signedFile();
    const { io, out, files } = fileIO(counterAudit(records));
    files["one.json"] = text;
    await runFile(["verify", "one.json"], io);
    const printed = out.join("\n");
    expect(printed).toContain(
      `Review log: assembled at sequence 4 (packet ${idOf(4)})`
    );
    expect(printed).toContain(
      "Review log: position and 2 decision(s) verified against the review organization"
    );
  });

  it("fails a decision CounterAudit holds differently", async () => {
    const { records, text } = await signedFile();
    // The packet the file names for Alice's approval holds something else.
    const swapped = {
      ...(records[3] as Record<string, unknown>),
      decision: "reject",
    };
    const { io, out, files } = fileIO(
      counterAudit(records, { swap: { 3: swapped } })
    );
    files["one.json"] = text;
    expect(await runFile(["verify", "one.json"], io)).toBe(1);
    expect(out.join("\n")).toContain(
      `Review log: FAILED: decision ${idOf(3)} is not the approve at sequence 3`
    );
  });

  // Review F-03 (1 November 2026): a signed file stays signed after a reviewer rejects its line.
  it("--current passes while the review log as it is now still releases each line", async () => {
    const { records, text } = await signedFile();
    const { io, out, files } = fileIO(counterAudit(records));
    files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--current"], io)).toBe(0);
    expect(out.join("\n")).toContain(
      "Current standing: 1 released line(s) still stand in the review log, read whole to sequence 4"
    );
  });

  it("--current fails a line whose evidence was sealed again with another result, or that names no seal", async () => {
    const { records, text } = await signedFile();
    const verifyWith = async (evidence: unknown[], fileText = text) => {
      const { io, out, files } = fileIO(counterAudit(records, { evidence }));
      files["one.json"] = fileText;
      return { code: await runFile(["verify", "one.json", "--current"], io), printed: out.join("\n") };
    };
    // Sealed again with the same result: it still stands.
    const again = await verifyWith([lineSeal(), lineSeal({ checked_at: "2026-11-01T12:00:00.000Z" })]);
    expect(again.code).toBe(0);
    const changed = await verifyWith([
      lineSeal(),
      lineSeal({ evidence_digest: "f".repeat(64), checked_at: "2026-11-01T12:00:00.000Z" }),
    ]);
    expect(changed.code).toBe(1);
    expect(changed.printed).toContain(
      `its evidence was checked again since; the result CounterAudit sealed last for it (packet ${sealId(1)}) is not the one it was released on`
    );
    const gone = await verifyWith([]);
    expect(gone.code).toBe(1);
    expect(gone.printed).toContain("CounterAudit holds no evidence result sealed for it");
    // A result that needs a waiver: the plain approvals do not count for it.
    const waiver = await verifyWith([lineSeal({ needs_waiver: true })]);
    expect(waiver.code).toBe(1);
    expect(waiver.printed).toContain("has 0 current approval(s) and needs 1");
    const failed = await verifyWith([lineSeal({ status: "failed" })]);
    expect(failed.code).toBe(1);
    expect(failed.printed).toContain("its evidence is failed, which no approval releases");

    // A file assembled before evidence was sealed names no seal.
    const { signature: _signature, ...draft } = JSON.parse(text) as SignedAgentFile;
    const { evidence_seal: _seal, ...unsealedLine } = draft.furnished_outcomes[0];
    const old = signFile(
      { ...draft, furnished_outcomes: [unsealedLine] },
      fileKey.privateKeyPem,
      "test-file-1",
      { "test-file-1": fileKey.publicKey }
    );
    const unsealed = await verifyWith([lineSeal()], JSON.stringify(old));
    expect(unsealed.code).toBe(1);
    expect(unsealed.printed).toContain("does not name the evidence result it was released on; assemble a new one");

    // Without the Bureau's read key, its standing is not established.
    delete process.env.COUNTERAUDIT_READ_KEY;
    const keyless = await verifyWith([lineSeal()]);
    expect(keyless.code).toBe(3);
    expect(keyless.printed).toContain("needs COUNTERAUDIT_ORG_ID and COUNTERAUDIT_READ_KEY to read the evidence seals");
  });

  it("--current fails a file whose line a reviewer rejected after it was assembled", async () => {
    const { records, text } = await signedFile();
    const later = [
      ...records,
      decision("alice", "reject", "2026-11-01T11:00:00.000Z"),
    ];
    const historical = fileIO(counterAudit(later));
    historical.files["one.json"] = text;
    // As assembled, it still checks out, and says that is all it says.
    expect(await runFile(["verify", "one.json"], historical.io)).toBe(0);
    expect(historical.out.join("\n")).toContain("Review status: as assembled");

    const { io, out, files } = fileIO(counterAudit(later));
    files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--current"], io)).toBe(1);
    expect(out.join("\n")).toContain("was rejected by rev_alice (sequence 5)");
  });

  it("--current fails a live line whose furnisher is no longer admitted for the key its proof names", async () => {
    // A live line's file, as it would be signed once counsel lifts LIVE_FILES_HELD.
    source.answer = () => ({
      ok: true,
      proof: proofFor({
        outcome_claim: {
          outcome: event.outcome,
          asserted_by: "signature",
          signer: { furnisher_id: event.furnisher_id, key_id: event.key_id, public_key: pilotKey },
          signed_event_hash: LINE.signedEventHash,
        },
      }),
    });
    const records = [
      ...genesis(),
      admit("alice"),
      admit("bob"),
      decision("alice", "approve", "2026-11-01T10:00:00.000Z", "live"),
      decision("bob", "approve", "2026-11-01T10:05:00.000Z", "live"),
    ];
    const { text } = await signedFile();
    const { signature: _signature, ...draft } = JSON.parse(text) as SignedAgentFile;
    const line = { ...draft.furnished_outcomes[0], data_class: "live" as const, released: "two_person" as const };
    line.review_decisions = [5, 6].map(n => ({ sequence: n, packet_id: idOf(n), decision: "approve" }));
    const liveFile = signFile(
      {
        ...draft,
        furnished_outcomes: [line],
        review_log: { org_id: REVIEW_ORG, sequence: 6, entry_hash: hashOf(6), packet_id: idOf(6) },
      },
      fileKey.privateKeyPem,
      "test-file-1",
      { "test-file-1": fileKey.publicKey }
    );
    const verifyAgainst = async (log: unknown[], evidence?: unknown[]) => {
      const { io, out, files } = fileIO(counterAudit(log, { evidence }));
      files["live.json"] = JSON.stringify(liveFile);
      return { code: await runFile(["verify", "live.json", "--current"], io), printed: out.join("\n") };
    };

    const standing = await verifyAgainst(records);
    expect(standing.printed).toContain("Current standing: 1 released line(s) still stand");
    expect(standing.code).toBe(0);

    // Its result needs a waiver, and it was sealed during its furnisher's probation: no approval
    // can waive anything for it, though both reviewers waived.
    const waived = [
      ...genesis(),
      admit("alice"),
      admit("bob"),
      decision("alice", "approve_with_waiver", "2026-11-01T10:00:00.000Z", "live"),
      decision("bob", "approve_with_waiver", "2026-11-01T10:05:00.000Z", "live"),
    ];
    const probation = await verifyAgainst(waived, [lineSeal({ needs_waiver: true })]);
    expect(probation.code).toBe(1);
    expect(probation.printed).toContain(
      "its furnisher is on probation, when no approval can waive anything for its lines"
    );

    const revoke = signAdmission(
      {
        schema: ADMISSION_SCHEMA,
        reviewer_id: "rev_carol",
        furnisher_id: LINE.furnisherId,
        decision: "revoke",
        reason: "its key may have leaked",
        decided_at: "2026-11-01T11:00:00.000Z",
      },
      people.carol.privateKeyPem
    );
    const revoked = await verifyAgainst([...records, revoke]);
    expect(revoked.code).toBe(1);
    expect(revoked.printed).toContain("its furnisher's admission was revoked by rev_carol at sequence 7");

    // Admitted again, with another key only.
    const otherKey = newReviewerKey().publicKey;
    const rekeyed = await verifyAgainst([...records, revoke, admit("alice", otherKey), admit("bob", otherKey)]);
    expect(rekeyed.code).toBe(1);
    expect(rekeyed.printed).toContain(`its key ${event.key_id} is not one its furnisher was admitted with`);
  });

  it("--current exits 3 when it cannot read the whole review log, or has no key for it", async () => {
    const { records, text } = await signedFile();
    const gap = fileIO(counterAudit(records, { skip: [2] }));
    gap.files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--current"], gap.io)).toBe(3);
    expect(gap.out.join("\n")).toContain("Current standing: NOT ESTABLISHED");

    delete process.env.COUNTERAUDIT_REVIEW_READ_KEY;
    const keyless = fileIO(counterAudit(records));
    keyless.files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--current"], keyless.io)).toBe(
      3
    );
    expect(keyless.out.join("\n")).toContain("COUNTERAUDIT_REVIEW_READ_KEY");
  });

  it("--current exits 3 when the review log is short of a head pinned in COUNTERAUDIT_REVIEW_MIN_HEAD", async () => {
    const { records, text } = await signedFile();
    const last = records.length - 1;
    process.env.COUNTERAUDIT_REVIEW_MIN_HEAD = `${last}:${hashOf(last)}`;
    const at = fileIO(counterAudit(records));
    at.files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--current"], at.io)).toBe(0);

    process.env.COUNTERAUDIT_REVIEW_MIN_HEAD = `${last + 2}:${hashOf(last + 2)}`;
    const short = fileIO(counterAudit(records));
    short.files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--current"], short.io)).toBe(3);
    expect(short.out.join("\n")).toContain(`below sequence ${last + 2}, which the review log has already reached: its head went back`);

    process.env.COUNTERAUDIT_REVIEW_MIN_HEAD = "latest";
    const malformed = fileIO(counterAudit(records));
    malformed.files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--current"], malformed.io)).toBe(3);
    expect(malformed.out.join("\n")).toContain('COUNTERAUDIT_REVIEW_MIN_HEAD is not "sequence:entryhash"');
  });

  it("says the references were not checked without the read key, and states them offline", async () => {
    const { records, text } = await signedFile();
    delete process.env.COUNTERAUDIT_REVIEW_READ_KEY;
    const online = fileIO(counterAudit(records));
    online.files["one.json"] = text;
    await runFile(["verify", "one.json"], online.io);
    expect(online.out.join("\n")).toContain(
      "Review log: not checked against CounterAudit"
    );

    const offline = fileIO(counterAudit(records));
    offline.files["one.json"] = text;
    expect(await runFile(["verify", "one.json", "--offline"], offline.io)).toBe(
      0
    );
    expect(offline.out.join("\n")).toContain(
      "Review log: assembled at sequence 4"
    );
  });
});

describe("a line and its source's retention date", () => {
  const records = () => [
    ...genesis(),
    decision("alice", "approve", "2026-11-01T10:00:00.000Z"),
    decision("bob", "approve", "2026-11-01T10:05:00.000Z"),
  ];

  it("states each line checkable until its source's retention date, and says what happens then", async () => {
    const { io, files } = fileIO(counterAudit(records()));
    expect(await assemble(io, "one.json")).toBe(0);
    const file = JSON.parse(files["one.json"]) as SignedAgentFile;
    expect(file.furnished_outcomes[0].counteraudit.checkable_until).toBe(
      RETAINED_UNTIL
    );
    expect(file.disclosures.some(d => d.includes("checkable_until"))).toBe(
      true
    );

    // A source with no retention date: checkable for as long as CounterAudit keeps it.
    source.answer = () => ({
      ok: true,
      proof: proofFor({ expires_at: undefined }),
    });
    const open = fileIO(counterAudit(records()));
    expect(await assemble(open.io, "two.json")).toBe(0);
    const openFile = JSON.parse(open.files["two.json"]) as SignedAgentFile;
    expect(
      openFile.furnished_outcomes[0].counteraudit.checkable_until
    ).toBeNull();
    expect(openFile.disclosures.some(d => d.includes("checkable_until"))).toBe(
      false
    );
  });

  it("leaves off a line whose source is erased or past its retention date", async () => {
    source.answer = () => gone();
    const erased = fileIO(counterAudit(records()));
    expect(await assemble(erased.io, "one.json")).toBe(0);
    expect(JSON.parse(erased.files["one.json"]).furnished_outcomes).toEqual([]);
    expect(erased.out.join("\n")).toContain(
      `Left off, its source has expired: ${LINE.packetId}: CounterAudit erased it at ${ERASED_AT}`
    );

    // Past the date, and not erased yet: CounterAudit's daily job has not run.
    source.answer = () => ({
      ok: true,
      proof: proofFor({ expires_at: "2026-11-01T11:00:00.000Z" }),
    });
    const due = fileIO(counterAudit(records()));
    expect(await assemble(due.io, "two.json")).toBe(0);
    expect(JSON.parse(due.files["two.json"]).furnished_outcomes).toEqual([]);
    expect(due.out.join("\n")).toContain(
      "it reached its retention date, 2026-11-01T11:00:00.000Z"
    );
  });

  it("says how many lines were left off as expired, not that no line names the subject", async () => {
    source.answer = () => gone();
    const erased = fileIO(counterAudit(records()));
    expect(await assemble(erased.io, "one.json")).toBe(0);
    const printed = erased.out.join("\n");
    expect(printed).toContain(
      "No line is on the file: 1 released line naming this subject was left off because its source has expired."
    );
    expect(printed).not.toContain("check the spelling");

    // With nothing left off, a file with no line still suggests the spelling.
    store.lines = [];
    const none = fileIO(counterAudit(records()));
    expect(await assemble(none.io, "two.json")).toBe(0);
    expect(none.out.join("\n")).toContain(
      "No released line names exactly this subject."
    );
  });

  it("signs nothing when a line's proof cannot be read, or it or the erasure record does not check", async () => {
    const cases: [() => ProofResult, string][] = [
      [
        () => ({ ok: false, status: 503, message: "proof_unavailable" }),
        "its proof could not be read: proof_unavailable",
      ],
      [
        () => ({ ok: true, proof: proofFor({ entry_hash: "f".repeat(64) }) }),
        "its proof does not check: entry_hash",
      ],
      [
        () => ({ ok: true, proof: proofFor({ expires_at: "soon" }) }),
        "its proof's expires_at is not a time",
      ],
      [
        () => gone(tombstoneFor({ sequence: 8 })),
        "record of erasing it does not check",
      ],
      [
        () => gone(tombstoneFor({}, generateKeyPairSync("ed25519").privateKey)),
        "signature_invalid",
      ],
    ];
    for (const [answer, said] of cases) {
      source.answer = answer;
      const { io, out, files } = fileIO(counterAudit(records()));
      expect(await assemble(io, "out.json")).toBe(1);
      expect(files["out.json"]).toBeUndefined();
      expect(out.join("\n")).toContain("Not signed:");
      expect(out.join("\n")).toContain(said);
    }
  });

  it("lets a line disputing a file's line act on CounterAudit's proof of it, and signs nothing it cannot check", async () => {
    // A later line of the same furnisher disputing LINE, and CounterAudit's proof of it.
    const disputeEvent = {
      ...unsignedEvent,
      event_id: "event-2",
      occurred_at: "2026-10-31T12:00:00.000Z",
      outcome: "disputed",
      relation: { type: "disputes", target_event_id: event.event_id },
      signature: event.signature,
    };
    const DISPUTE = {
      ...LINE,
      id: 2,
      eventId: disputeEvent.event_id,
      relationType: "disputes" as const,
      relationTargetEventId: event.event_id,
      outcome: disputeEvent.outcome,
      occurredAt: new Date(disputeEvent.occurred_at),
      packetId: "29879d36-0000-4000-8000-000000000002",
      sequence: 8,
      entryHash: "f".repeat(64),
      signedEventHash: signedEventHash(disputeEvent),
      signedEvent: disputeEvent,
    };
    const disputeProof = (changes: Record<string, unknown> = {}) =>
      proofFor({
        packet_id: DISPUTE.packetId,
        sequence: DISPUTE.sequence,
        entry_hash: DISPUTE.entryHash,
        outcome_claim: {
          outcome: DISPUTE.outcome,
          asserted_by: "signature",
          signer: { furnisher_id: event.furnisher_id, key_id: event.key_id, public_key: "ed25519:test" },
          signed_event_hash: DISPUTE.signedEventHash,
        },
        ...changes,
      });
    const run = async (dispute: typeof DISPUTE, answer: ProofResult | undefined) => {
      store.lines = [LINE, dispute];
      const env = fileIO(counterAudit(records()));
      env.io.fetchProof = vi.fn(async (packetId: string) =>
        packetId === LINE.packetId
          ? { ok: true as const, proof: proofFor() }
          : (answer ?? { ok: false as const, status: 404, message: "not_found" })
      );
      const code = await assemble(env.io, "out.json");
      const file = env.files["out.json"]
        ? (JSON.parse(env.files["out.json"]) as SignedAgentFile)
        : null;
      return { code, file, out: env.out.join("\n") };
    };

    // Its stored proofOk edited off: it acts, on CounterAudit's proof.
    const edited = await run({ ...DISPUTE, proofOk: false }, { ok: true, proof: disputeProof() });
    expect(edited.code).toBe(0);
    expect(edited.file?.furnished_outcomes.map(l => l.display_state)).toEqual(["disputed"]);

    // One CounterAudit has no proof of, or one held as passed whose proof does not check: no file.
    const unknown = await run(DISPUTE, undefined);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain(`Not signed: ${DISPUTE.packetId}: its proof could not be read: not_found`);
    const failing = { ok: true as const, proof: disputeProof({ entry_hash: "0".repeat(64) }) };
    const changed = await run(DISPUTE, failing);
    expect(changed.code).toBe(1);
    expect(changed.out).toContain(
      `Not signed: ${DISPUTE.packetId}: the Bureau holds it as passed, but its proof does not check: entry_hash`
    );

    // A seal time that is not a time stops it, rather than throwing.
    const undated = await run({ ...DISPUTE, caCreatedAt: new Date(Number.NaN) }, { ok: true, proof: disputeProof() });
    expect(undated.code).toBe(1);
    expect(undated.out).toContain(`Not signed: ${DISPUTE.packetId}: its seal time is not a time`);

    // Held as not passed, with a proof that does not check, or erased: it does not act.
    for (const answer of [
      failing,
      gone(tombstoneFor({ packet_id: DISPUTE.packetId, sequence: DISPUTE.sequence, entry_hash: DISPUTE.entryHash })),
    ]) {
      const quiet = await run({ ...DISPUTE, proofOk: false }, answer);
      expect(quiet.code).toBe(0);
      expect(quiet.file?.furnished_outcomes.map(l => l.display_state)).toEqual(["released"]);
    }
  });

  it("verifies a line whose source was erased since as expired, not failed", async () => {
    const signed = fileIO(counterAudit(records()));
    expect(await assemble(signed.io, "one.json")).toBe(0);

    source.answer = () => gone();
    const { io, out, files } = fileIO(counterAudit(records()));
    files["one.json"] = signed.files["one.json"];
    expect(await runFile(["verify", "one.json"], io)).toBe(0);
    expect(out.join("\n")).toContain(
      `${LINE.packetId}: expired: CounterAudit erased its source at ${ERASED_AT}, before the file's checkable_until (${RETAINED_UNTIL}); the line rests on the Bureau's signature alone`
    );

    // A record of erasure CounterAudit did not sign, or for another place in the chain, fails.
    for (const tombstone of [
      tombstoneFor({}, generateKeyPairSync("ed25519").privateKey),
      tombstoneFor({ entry_hash: "f".repeat(64) }),
    ]) {
      source.answer = () => gone(tombstone);
      const forged = fileIO(counterAudit(records()));
      forged.files["one.json"] = signed.files["one.json"];
      expect(await runFile(["verify", "one.json"], forged.io)).toBe(1);
      expect(forged.out.join("\n")).toContain(
        `${LINE.packetId}: erasure record FAILED`
      );
    }
  });
});
