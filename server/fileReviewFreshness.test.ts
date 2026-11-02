// pnpm file assemble against the review log as CounterAudit holds it now (review M-01): a
// rejection sealed since the last pnpm review sync must hold its line on the next file, and a
// file is not signed against a log the Bureau could not read to its head. Also each line against
// its source's retention date: checkable until then, and expired, not failed, once erased.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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

import { runFile, type FileIO, type SignedAgentFile } from "./agentFile";
import type { ProofResult } from "./counteraudit";
import { canonicalizeJson, signedEventHash } from "./outcomeProof";
import {
  REVIEW_SCHEMA,
  evidenceDigest,
  newReviewerKey,
  signReviewDecision,
} from "./reviewDecision";
import { REVIEWER_KEY_SCHEMA, genesisHash, signKeyRecord } from "./reviewLog";

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

// One stored line, read from its signed event.
const event = {
  schema_version: "1",
  furnisher_id: "fur_bureaupilot01",
  key_id: "pilot-2026-10",
  event_id: "event-1",
  subject_ref: { wallet: WALLET },
  occurred_at: "2026-10-31T10:00:00.000Z",
  outcome: "delivered",
  signature: "ed25519:test",
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
  verdict: "approve" | "reject",
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
      // A rejection is counted only with a reason.
      ...(verdict === "reject" ? { reason: "related payer" } : {}),
      decided_at: decidedAt,
    },
    people[reviewer].privateKeyPem
  );

// CounterAudit's list and verify routes over a review organization holding these records.
function counterAudit(
  records: unknown[],
  options: { skip?: number[]; swap?: Record<number, unknown> } = {}
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
  process.env.COUNTERAUDIT_REVIEW_ORG_ID = REVIEW_ORG;
  process.env.COUNTERAUDIT_REVIEW_READ_KEY = "ca_read_review";
  process.env.COUNTERAUDIT_API_URL = API;
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
    store.lines = [{ ...LINE, dataClass: "live" as const }];
    const released = [
      ...genesis(),
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
