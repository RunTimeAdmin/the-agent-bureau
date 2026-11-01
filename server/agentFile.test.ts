import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assembleFile,
  checkFileSignature,
  duplicateKey,
  FILE_SCHEMA,
  NOT_ON_FILE,
  PAYMENT_DISCLOSURE,
  readSubjectRef,
  runFile,
  signFile,
  type AssembleOptions,
  type FileIO,
  type SignedAgentFile,
  type StoredLine,
} from "./agentFile";
import { BUREAU_FILE_KEYS } from "./bureauFileKeys";
import type { Furnisher } from "./furnishers";
import type { Line, Review } from "./lineState";
import {
  parsePublicKey,
  signedEventHash,
  verifyLineProof,
  type Jwks,
} from "./outcomeProof";
import { evidenceDigest, newReviewerKey } from "./reviewDecision";

const read = (name: string) =>
  readFileSync(path.join(__dirname, "fixtures", "counteraudit", name), "utf8");
const proof = JSON.parse(read("proof.json")) as Record<string, unknown>;
const jwks = JSON.parse(read("jwks.json")) as Jwks;
const realEvent = JSON.parse(read("signed.jsonl").trim()) as Record<
  string,
  unknown
>;
const claim = proof.outcome_claim as Record<string, unknown>;
const signer = claim.signer as Record<string, string>;

const WALLET = "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77";
const BUREAU_ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
const EVIDENCE = { status: "verified", reasons: [] };
const NOW = new Date("2026-11-01T01:00:00.000Z");

let nextId = 1;
// A stored line and the signed event it was read from. Later lines happened
// later. The event's signature is not checked here: the intake checked it
// through CounterAudit's proof before storing the line.
function stored(
  overrides: Partial<StoredLine> = {},
  event: Record<string, unknown> = {}
): StoredLine {
  const id = nextId++;
  const furnisherId = overrides.furnisherId ?? "fur_bureaupilot01";
  const eventId = overrides.eventId ?? `event-${id}`;
  const signedEvent = {
    schema_version: "1",
    furnisher_id: furnisherId,
    key_id: "pilot-2026-10",
    event_id: eventId,
    subject_ref: { wallet: WALLET },
    occurred_at: new Date(Date.UTC(2026, 9, 1) + id * 60_000).toISOString(),
    outcome: "delivered",
    signature: "ed25519:test",
    ...event,
  };
  const relation = signedEvent.relation as
    { type: Line["relationType"]; target_event_id: string } | undefined;
  return {
    id,
    furnisherId,
    eventId,
    subjectRef: signedEvent.subject_ref as Record<string, unknown>,
    dataClass: "test",
    proofOk: true,
    evidenceStatus: "verified",
    evidenceResult: EVIDENCE,
    evidenceKey: null,
    signedEventHash: signedEventHash(signedEvent),
    displayState: "unverified",
    relationType: relation?.type ?? null,
    relationTargetEventId: relation?.target_event_id ?? null,
    outcome: signedEvent.outcome as string,
    occurredAt: new Date(signedEvent.occurred_at as string),
    receivedAt: new Date("2026-10-31T00:00:00.000Z"),
    caCreatedAt: new Date("2026-10-31T00:00:01.000Z"),
    packetId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    entryHash: "e".repeat(64),
    sequence: id,
    signedEvent,
    ...overrides,
  };
}

// The review log, as reviewsFor hands it over: decisions by line.
function reviewLog() {
  const byLine = new Map<number, Review[]>();
  return {
    approve(line: StoredLine, decision: Review["decision"] = "approve") {
      byLine.set(line.id, [
        ...(byLine.get(line.id) ?? []),
        {
          id: nextId++,
          reviewerId: `rev_${byLine.get(line.id)?.length ?? 0}`,
          decision,
          signedEventHash: line.signedEventHash,
          dataClass: line.dataClass,
          evidenceDigest: evidenceDigest(line.evidenceResult),
          decidedAt: new Date("2026-10-31T10:00:00.000Z"),
        },
      ]);
      return line;
    },
    reviewsOf: (line: Line) => byLine.get(line.id) ?? [],
  };
}

const OPTIONS: AssembleOptions = {
  now: NOW,
  bureauOrgId: BUREAU_ORG,
  testnetReviewers: false,
  furnishers: {},
};

describe("assembleFile", () => {
  it("shows the subject's released lines, newest first, read from their signed events", () => {
    const log = reviewLog();
    const older = log.approve(stored());
    const newer = log.approve(stored());
    const held = stored();
    const otherSubject = log.approve(
      stored({}, { subject_ref: { wallet: `0x${"1".repeat(40)}` } })
    );
    const { file, skipped } = assembleFile(
      // An EVM wallet matches without case.
      { wallet: WALLET.toLowerCase() },
      [older, newer, held, otherSubject],
      log.reviewsOf,
      { ...OPTIONS, fileId: "f-1", proofBase: "https://ca.example/" }
    );
    expect(skipped).toEqual([]);
    expect(file.schema).toBe(FILE_SCHEMA);
    expect(file.issued_at).toBe(NOW.toISOString());
    expect(file.reviewers).toBe("independent");
    expect(file.subject).toEqual({
      subject_ref: { wallet: WALLET.toLowerCase() },
      matching: "exact",
    });
    expect(file.furnished_outcomes.map(l => l.counteraudit.packet_id)).toEqual([
      newer.packetId,
      older.packetId,
    ]);
    expect(file.history).toEqual([]);
    expect(file.furnished_outcomes[0]).toEqual({
      outcome: "delivered",
      occurred_at: (newer.signedEvent as Record<string, string>).occurred_at,
      received_at: "2026-10-31T00:00:00.000Z",
      sealed_at: "2026-10-31T00:00:01.000Z",
      data_class: "test",
      furnisher_category: "Bureau pilot test furnisher",
      display_state: "released",
      released: "solo_test",
      evidence: "verified",
      counteraudit: {
        packet_id: newer.packetId,
        org_id: BUREAU_ORG,
        sequence: newer.sequence,
        entry_hash: newer.entryHash,
        signed_event_hash: newer.signedEventHash,
        proof_url: `https://ca.example/v1/proofs/${newer.packetId}`,
      },
    });
    expect(file.not_on_file).toEqual(NOT_ON_FILE);
  });

  it("ignores the table's copies of a line's fields, which nothing signs", () => {
    const log = reviewLog();
    const other = { wallet: `0x${"2".repeat(40)}` };
    // Someone changed the stored subject, outcome and time of a released line.
    const moved = log.approve(
      stored({
        subjectRef: other,
        outcome: "payment_failed",
        occurredAt: new Date("2030-01-01T00:00:00Z"),
      })
    );
    const onOther = assembleFile(other, [moved], log.reviewsOf, OPTIONS);
    expect(onOther.file.furnished_outcomes).toEqual([]);
    const onTrue = assembleFile(
      { wallet: WALLET },
      [moved],
      log.reviewsOf,
      OPTIONS
    ).file.furnished_outcomes;
    expect(onTrue).toHaveLength(1);
    expect(onTrue[0].outcome).toBe("delivered");
    expect(onTrue[0].occurred_at).toBe(
      (moved.signedEvent as Record<string, string>).occurred_at
    );
  });

  it("leaves off a line whose signed event does not check, and says why", () => {
    const log = reviewLog();
    const swapped = log.approve(stored());
    swapped.signedEvent = {
      ...(swapped.signedEvent as object),
      outcome: "not_delivered",
    };
    const renamed = log.approve(stored());
    renamed.eventId = "another-event";
    const { file, skipped } = assembleFile(
      { wallet: WALLET },
      [swapped, renamed],
      log.reviewsOf,
      OPTIONS
    );
    expect(file.furnished_outcomes).toEqual([]);
    expect(skipped).toEqual([
      `${swapped.furnisherId}/${swapped.eventId}: the signed event does not hash to the line's signed_event_hash`,
      `${renamed.furnisherId}/another-event: the signed event names another furnisher or event`,
    ]);
  });

  it("names payments by what the chain proves, and never calls a screen clear that is not", () => {
    const log = reviewLog();
    const clear = log.approve(
      stored(
        {
          evidenceResult: { ...EVIDENCE, funding_screen: { result: "clear" } },
        },
        { outcome: "paid" }
      )
    );
    const flagged = log.approve(
      stored(
        {
          evidenceResult: {
            ...EVIDENCE,
            funding_screen: { result: "flagged" },
          },
        },
        { outcome: "paid" }
      )
    );
    const unread = log.approve(
      stored(
        {
          evidenceResult: {
            ...EVIDENCE,
            funding_screen: { result: "read_failed" },
          },
        },
        { outcome: "payment_failed" }
      )
    );
    const lines = assembleFile(
      { wallet: WALLET },
      [clear, flagged, unread],
      log.reviewsOf,
      OPTIONS
    ).file.furnished_outcomes;
    const of = (l: StoredLine) =>
      lines.find(f => f.counteraudit.packet_id === l.packetId)!;
    expect(of(clear)).toMatchObject({
      evidence: "payment_settlement_verified",
      payment: {
        subject_control: "unproven",
        payer_independence_screen: "clear",
      },
    });
    expect(of(flagged).payment?.payer_independence_screen).toBe("flagged");
    expect(of(unread)).toMatchObject({
      evidence: "payment_failure_verified",
      payment: {
        subject_control: "unproven",
        payer_independence_screen: "inconclusive",
      },
    });
  });

  it("says when reviewers waived the evidence", () => {
    const log = reviewLog();
    const waived = stored({
      evidenceStatus: "needs_review",
      evidenceResult: { status: "needs_review", reasons: ["no machine check"] },
    });
    log.approve(waived, "approve_with_waiver");
    const { file } = assembleFile(
      { wallet: WALLET },
      [waived],
      log.reviewsOf,
      OPTIONS
    );
    expect(file.furnished_outcomes[0].evidence).toBe("waived_by_reviewers");
  });

  it("keeps a disputed line standing and moves a withdrawn one to history", () => {
    const log = reviewLog();
    const disputed = log.approve(stored());
    const dispute = stored(
      {},
      {
        outcome: "disputed",
        relation: { type: "disputes", target_event_id: disputed.eventId },
      }
    );
    const withdrawn = log.approve(stored());
    const withdrawal = stored(
      {},
      { relation: { type: "withdraws", target_event_id: withdrawn.eventId } }
    );
    const { file } = assembleFile(
      { wallet: WALLET },
      [disputed, dispute, withdrawn, withdrawal],
      log.reviewsOf,
      OPTIONS
    );
    expect(
      file.furnished_outcomes.map(l => [
        l.counteraudit.packet_id,
        l.display_state,
      ])
    ).toEqual([[disputed.packetId, "disputed"]]);
    expect(
      file.history.map(l => [l.counteraudit.packet_id, l.display_state])
    ).toEqual([[withdrawn.packetId, "withdrawn"]]);
    expect(file.disclosures.some(d => d.startsWith("history lists"))).toBe(
      true
    );
  });

  it("takes a relation only from the relating line's signed event", () => {
    const log = reviewLog();
    const target = log.approve(stored());
    // The table says it withdraws the target; its signed event says nothing of the kind.
    const forged = stored({
      relationType: "withdraws",
      relationTargetEventId: target.eventId,
    });
    const { file } = assembleFile(
      { wallet: WALLET },
      [target, forged],
      log.reviewsOf,
      OPTIONS
    );
    expect(file.furnished_outcomes.map(l => l.display_state)).toEqual([
      "released",
    ]);
  });

  it("carries the disclosures every file needs, and says who the reviewers were", () => {
    const log = reviewLog();
    const { file } = assembleFile(
      { wallet: WALLET },
      [log.approve(stored())],
      log.reviewsOf,
      { ...OPTIONS, testnetReviewers: true }
    );
    expect(file.reviewers).toBe("operator_held_testnet");
    expect(file.disclosures).toContain(PAYMENT_DISCLOSURE);
    expect(file.disclosures.some(d => d.includes("solo_test"))).toBe(true);
    expect(
      file.disclosures.some(d =>
        d.includes("testnet keys the Bureau's operator holds")
      )
    ).toBe(true);
    expect(
      file.disclosures.some(d =>
        d.startsWith("Every line on this file is test data")
      )
    ).toBe(true);
    const empty = assembleFile(
      { wallet: WALLET },
      [],
      log.reviewsOf,
      OPTIONS
    ).file;
    expect(empty.furnished_outcomes).toEqual([]);
    expect(empty.disclosures).toContain(PAYMENT_DISCLOSURE);
    expect(
      empty.disclosures.some(d =>
        d.startsWith("Every line on this file is test data")
      )
    ).toBe(false);
  });

  it("names a listed furnisher's own organization", () => {
    const log = reviewLog();
    const line = log.approve(stored({ furnisherId: "fur_listed01" }));
    const furnishers: Record<string, Furnisher> = {
      fur_listed01: { counterauditOrgId: String(proof.org_id), keys: {} },
    };
    const { file } = assembleFile({ wallet: WALLET }, [line], log.reviewsOf, {
      ...OPTIONS,
      furnishers,
    });
    expect(file.furnished_outcomes[0].counteraudit.org_id).toBe(proof.org_id);
    expect(file.furnished_outcomes[0].furnisher_category).toBe(
      "category not listed"
    );
  });
});

describe("readSubjectRef", () => {
  it("takes the three v1 forms, exactly", () => {
    for (const ok of [
      { wallet: WALLET },
      { wallet: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV" },
      { did: "did:sigvara:5042002:0xCc52Cd92963f8A86d04dB29a4810d1e01D193910" },
      { chain: "arc", registry: "erc8004", id: "42" },
    ]) {
      expect(readSubjectRef(ok)).toEqual(ok);
    }
    for (const bad of [
      null,
      "x",
      {},
      { wallet: "alice" },
      { wallet: WALLET, did: "did:a:b" },
      { did: "DID:A:b" },
      { chain: "ethereum", registry: "r", id: "1" },
      { chain: "arc", registry: "", id: "1" },
    ]) {
      expect(typeof readSubjectRef(bad)).toBe("string");
    }
  });
});

describe("signing a file", () => {
  const { privateKeyPem, publicKey } = newReviewerKey();
  const keys = { "test-file-1": publicKey };
  const log = reviewLog();
  const { file } = assembleFile(
    { wallet: WALLET },
    [log.approve(stored())],
    log.reviewsOf,
    { ...OPTIONS, fileId: "f-2" }
  );

  it("signs with the pinned key and verifies unchanged", () => {
    const signed = signFile(file, privateKeyPem, "test-file-1", keys);
    expect(signed.signature).toMatchObject({
      algorithm: "ed25519",
      key_id: "test-file-1",
    });
    expect(
      checkFileSignature(JSON.parse(JSON.stringify(signed)), keys)
    ).toEqual({ ok: true });
  });

  it("refuses a key that is not pinned, or not the one pinned", () => {
    expect(() => signFile(file, privateKeyPem, "other", keys)).toThrow(
      "is not pinned"
    );
    expect(() =>
      signFile(file, newReviewerKey().privateKeyPem, "test-file-1", keys)
    ).toThrow("is not the one pinned");
  });

  it("fails a changed file, an unpinned key and a malformed signature", () => {
    const signed = signFile(file, privateKeyPem, "test-file-1", keys);
    const changed = structuredClone(signed);
    changed.furnished_outcomes[0].display_state = "disputed";
    expect(checkFileSignature(changed, keys).ok).toBe(false);
    expect(checkFileSignature(signed, { other: publicKey })).toMatchObject({
      ok: false,
    });
    expect(
      checkFileSignature(
        {
          ...signed,
          signature: {
            ...signed.signature,
            value: `${signed.signature.value}=`,
          },
        },
        keys
      ).ok
    ).toBe(false);
    expect(
      checkFileSignature({ ...signed, schema: "agent-bureau/file/v2" }, keys).ok
    ).toBe(false);
    expect(checkFileSignature(null, keys).ok).toBe(false);
  });

  it("pins only keys that parse", () => {
    for (const key of Object.values(BUREAU_FILE_KEYS))
      expect(() => parsePublicKey(key)).not.toThrow();
  });
});

describe("duplicateKey", () => {
  it("finds a key repeated in one object, at any depth, however it is spelled", () => {
    expect(duplicateKey('{"a":1,"b":{"c":2,"c":3}}')).toBe("c");
    expect(duplicateKey('{"a":1,"\\u0061":2}')).toBe("a");
    expect(duplicateKey('{"x":[{"a":1},{"a":2}],"y":"\\"a\\""}')).toBeNull();
    expect(duplicateKey('[{"a":"a","b":["a","a"]}]')).toBeNull();
  });
});

describe("verifyLineProof", () => {
  const input = {
    proof,
    jwks,
    furnishers: {} as Record<string, Furnisher>,
    packetId: String(proof.packet_id),
    orgId: String(proof.org_id),
    sequence: proof.sequence as number,
    entryHash: String(proof.entry_hash),
    sealedAt: String(proof.created_at),
    signedEventHash: String(claim.signed_event_hash),
    outcome: String(claim.outcome),
  };

  it("passes a line that matches CounterAudit's signed proof", () => {
    expect(verifyLineProof(input).ok).toBe(true);
  });

  it("fails a line that says something else, or a proof that was changed", () => {
    for (const change of [
      { packetId: "00000000-0000-4000-8000-000000000000" },
      { orgId: BUREAU_ORG },
      { sequence: 1 },
      { entryHash: "f".repeat(64) },
      { sealedAt: "2026-10-30T18:55:05.529Z" },
      { signedEventHash: "f".repeat(64) },
      { outcome: "not_delivered" },
    ]) {
      expect(verifyLineProof({ ...input, ...change }).ok).toBe(false);
    }
    expect(
      verifyLineProof({ ...input, proof: { ...proof, sequence: 7 } }).checks
        .proof_signature.ok
    ).toBe(false);
    const unsigned = {
      ...proof,
      outcome_claim: { ...claim, asserted_by: "caller" },
    };
    expect(
      verifyLineProof({ ...input, proof: unsigned }).checks.outcome.ok
    ).toBe(false);
    expect(
      verifyLineProof({ ...input, proof: { ...proof, proof_version: 2 } })
        .checks.proof_type.ok
    ).toBe(false);
  });

  it("in a listed furnisher's organization, takes only a signer listed for it", () => {
    const listed = (publicKey: string): Record<string, Furnisher> => ({
      [signer.furnisher_id]: {
        counterauditOrgId: String(proof.org_id),
        keys: { [signer.key_id]: { publicKey, status: "revoked" } },
      },
    });
    expect(
      verifyLineProof({ ...input, furnishers: listed(signer.public_key) })
        .checks.signer_registered.ok
    ).toBe(true);
    expect(
      verifyLineProof({
        ...input,
        furnishers: listed(newReviewerKey().publicKey),
      }).checks.signer_registered.ok
    ).toBe(false);
  });
});

describe("pnpm file", () => {
  const { privateKeyPem, publicKey } = newReviewerKey();
  const keys = { "test-file-1": publicKey };

  function io(
    files: Record<string, string> = {}
  ): FileIO & { out: string[]; files: Record<string, string> } {
    const out: string[] = [];
    return {
      out,
      files,
      readText: async p => {
        if (!(p in files)) throw new Error("no such file");
        return files[p];
      },
      writeNewPrivateFile: async (p, text) => {
        if (p in files) throw new Error("exists");
        files[p] = text;
      },
      writeNewFile: async (p, text) => {
        if (p in files) throw new Error("exists");
        files[p] = text;
      },
      log: line => out.push(line),
      now: () => NOW,
      fetchProof: vi.fn(async () => ({ ok: true as const, proof })),
      jwks,
      keys,
      furnishers: {},
    };
  }

  // A file whose one line is the fixture's real sealed event.
  const subject = realEvent.subject_ref as Record<string, unknown>;
  function signedFixtureFile(): SignedAgentFile {
    const log = reviewLog();
    const line = log.approve(
      stored({
        furnisherId: String(realEvent.furnisher_id),
        eventId: String(realEvent.event_id),
        subjectRef: subject,
        signedEventHash: signedEventHash(realEvent),
        signedEvent: realEvent,
        packetId: String(proof.packet_id),
        sequence: proof.sequence as number,
        entryHash: String(proof.entry_hash),
        caCreatedAt: new Date(String(proof.created_at)),
      })
    );
    const { file, skipped } = assembleFile(subject, [line], log.reviewsOf, {
      ...OPTIONS,
      bureauOrgId: String(proof.org_id),
    });
    expect(skipped).toEqual([]);
    return signFile(file, privateKeyPem, "test-file-1", keys);
  }

  it("verifies the Bureau's signature and each line against CounterAudit's proof, and says who the file is about", async () => {
    const env = io({ "file.json": JSON.stringify(signedFixtureFile()) });
    expect(await runFile(["verify", "file.json"], env)).toBe(0);
    expect(env.out[0]).toBe("Bureau signature: verified");
    expect(env.out[1]).toBe(`About: ${JSON.stringify(subject)}`);
    expect(env.out.at(-1)).toBe(
      `${proof.packet_id}: proof verified (delivered, sealed in ${proof.org_id})`
    );
  });

  it("checks the subject and the age when asked", async () => {
    const env = io({ "file.json": JSON.stringify(signedFixtureFile()) });
    expect(
      await runFile(
        [
          "verify",
          "file.json",
          "--subject",
          JSON.stringify(subject),
          "--max-age-days",
          "1",
        ],
        env
      )
    ).toBe(0);
    expect(env.out).toContain("Subject: as expected");
    expect(env.out).toContain("Age: within 1 days");

    const other = io({ "file.json": JSON.stringify(signedFixtureFile()) });
    expect(
      await runFile(
        [
          "verify",
          "file.json",
          "--subject",
          JSON.stringify({ wallet: WALLET }),
          "--offline",
        ],
        other
      )
    ).toBe(1);
    expect(other.out).toContain(
      "Subject: FAILED: this file is about another subject"
    );

    const stale = io({ "file.json": JSON.stringify(signedFixtureFile()) });
    stale.now = () => new Date(NOW.getTime() + 3 * 86_400_000);
    expect(
      await runFile(
        ["verify", "file.json", "--max-age-days", "2", "--offline"],
        stale
      )
    ).toBe(1);
  });

  it("fails a line whose proof says otherwise, and a file whose signature does not hold", async () => {
    const file = signedFixtureFile();
    const env = io({ "file.json": JSON.stringify(file) });
    env.fetchProof = vi.fn(async () => ({
      ok: true as const,
      proof: {
        ...proof,
        outcome_claim: { ...claim, outcome: "not_delivered" },
      },
    }));
    expect(await runFile(["verify", "file.json"], env)).toBe(1);
    expect(env.out.at(-1)).toMatch(
      /proof FAILED: proof_signature: .*; outcome: /
    );

    const changed = structuredClone(file);
    changed.furnished_outcomes[0].outcome = "paid";
    const env2 = io({ "file.json": JSON.stringify(changed) });
    expect(await runFile(["verify", "file.json"], env2)).toBe(1);
    expect(env2.out[0]).toMatch(/^Bureau signature: FAILED/);
    expect(env2.fetchProof).not.toHaveBeenCalled();
  });

  it("refuses a file with a repeated key, and prints no control characters from it", async () => {
    const text = JSON.stringify(signedFixtureFile());
    const twice = io({
      "file.json": `{"furnished_outcomes":[],${text.slice(1)}`,
    });
    expect(await runFile(["verify", "file.json"], twice)).toBe(1);
    expect(twice.out[0]).toMatch(
      /^Refused: the key furnished_outcomes appears twice/
    );

    const escape = io({ "file.json": '{"a\u001b[31m": ' });
    expect(await runFile(["verify", "file.json"], escape)).toBe(1);
    expect(escape.out.join("\n")).not.toMatch(/\u001b/);
  });

  it("writes a new private key and prints its public key", async () => {
    const env = io();
    expect(await runFile(["keygen", "file.pem"], env)).toBe(0);
    expect(env.files["file.pem"]).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(
      env.out.some(l => /^Public key: ed25519:[A-Za-z0-9_-]{43}$/.test(l))
    ).toBe(true);
    expect(await runFile(["keygen", "file.pem"], env)).toBe(1);
  });

  it("refuses an assemble without every flag or with a subject not in a v1 form", async () => {
    const env = io({ "k.pem": privateKeyPem });
    expect(
      await runFile(["assemble", "--subject", "{}", "--key", "k.pem"], env)
    ).toBe(2);
    expect(
      await runFile(
        [
          "assemble",
          "--subject",
          '{"wallet":"alice"}',
          "--key",
          "k.pem",
          "--key-id",
          "test-file-1",
          "--out",
          "f.json",
        ],
        env
      )
    ).toBe(2);
    expect(env.out.at(-1)).toBe(
      "--subject: wallet is not an EVM or Solana address."
    );
  });
});
