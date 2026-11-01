import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  DISPUTE_SCHEMA,
  RESPONSE_DAYS,
  checkDisputeForm,
  checkFurnisherRecord,
  checkLineDisputes,
  checkStoredRecord,
  checkSubjectControl,
  currentDispute,
  deriveDisputes,
  signWithFurnisherKey,
  signWithWallet,
  walletAddress,
  walletSignatureVerifies,
  type FurnisherRecord,
  type StoredDisputeRecord,
  type WalletRecord,
} from "./dispute";
import {
  displayStateFor,
  lineStates,
  type Line,
  type Review,
} from "./lineState";
import { evidenceDigest, newReviewerKey } from "./reviewDecision";
import type { SigvaraClient } from "./sigvaraStanding";

const SUBJECT_KEY = generatePrivateKey();
const SUBJECT = walletAddress(SUBJECT_KEY);
const OTHER_KEY = generatePrivateKey();
const OTHER = walletAddress(OTHER_KEY);
const FURNISHER = "fur_levymerchant1";
const furnisherKey = newReviewerKey();
const strangerKey = newReviewerKey();
const HASH = "ab".repeat(32);
const EVIDENCE = { status: "verified", reasons: [] };
const ID = "6d1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const DAY = 86_400_000;
const T0 = new Date("2026-11-01T10:00:00.000Z");
const at = (days: number, ms = 0) => new Date(T0.getTime() + days * DAY + ms);

const LINE: Line = {
  id: 1,
  furnisherId: FURNISHER,
  eventId: "levy-sub8-charge1",
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
  signedEvent: {
    furnisher_id: FURNISHER,
    event_id: "levy-sub8-charge1",
    key_id: "levy-key-1",
    subject_ref: { wallet: SUBJECT },
  },
  // CounterAudit's ingest receipt, built from the same fields as the public proof.
  receipt: {
    receipt_type: "counteraudit.packet_receipt",
    receipt_version: 1,
    packet_id: "29879d36-0000-4000-8000-000000000001",
    org_id: "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1",
    sequence: 7,
    entry_hash: "e".repeat(64),
    created_at: "2026-10-20T11:00:01.000Z",
    outcome_claim: {
      outcome: "paid",
      asserted_by: "signature",
      event_id: "levy-sub8-charge1",
      signed_event_hash: HASH,
      signer: {
        furnisher_id: FURNISHER,
        key_id: "levy-key-1",
        public_key: furnisherKey.publicKey,
      },
    },
  },
};
const signer = { type: "eip191", address: SUBJECT };

const filing = (overrides: Record<string, unknown> = {}, key = SUBJECT_KEY) =>
  signWithWallet(
    {
      schema: DISPUTE_SCHEMA,
      kind: "dispute",
      dispute_id: ID,
      line: {
        furnisher_id: FURNISHER,
        event_id: LINE.eventId,
        signed_event_hash: HASH,
      },
      subject_ref: LINE.subjectRef,
      signer,
      reason: "I never made this payment.",
      filed_at: "2026-11-01T09:59:00.000Z",
      ...overrides,
    },
    key
  );
const response = (
  overrides: Record<string, unknown> = {},
  pem = furnisherKey.privateKeyPem
) =>
  signWithFurnisherKey(
    {
      schema: DISPUTE_SCHEMA,
      kind: "response",
      dispute_id: ID,
      furnisher_id: FURNISHER,
      key_id: "levy-key-1",
      response: "confirm",
      evidence: [{ tx_hash: `0x${"cd".repeat(32)}` }],
      responded_at: "2026-11-03T10:00:00.000Z",
      ...overrides,
    },
    pem
  );
const statement = (text = "The wallet that paid is not mine.") =>
  signWithWallet(
    {
      schema: DISPUTE_SCHEMA,
      kind: "statement",
      dispute_id: ID,
      signer,
      text,
      stated_at: "2026-11-04T10:00:00.000Z",
    },
    SUBJECT_KEY
  );
const subjectAppeal = () =>
  signWithWallet(
    {
      schema: DISPUTE_SCHEMA,
      kind: "appeal",
      dispute_id: ID,
      party: "subject",
      signer,
      reason: "The evidence names another wallet.",
      appealed_at: "2026-11-05T10:00:00.000Z",
    },
    SUBJECT_KEY
  );
const furnisherAppeal = (corrective = "levy-sub8-charge1-fixed") =>
  signWithFurnisherKey(
    {
      schema: DISPUTE_SCHEMA,
      kind: "appeal",
      dispute_id: ID,
      party: "furnisher",
      furnisher_id: FURNISHER,
      key_id: "levy-key-1",
      corrective_event_id: corrective,
      reason: "We missed the deadline; here is the corrected line.",
      appealed_at: "2026-11-21T10:00:00.000Z",
    },
    furnisherKey.privateKeyPem
  );

// Stored as pnpm dispute submit stores them, sealed at the given time, in order.
let next = 0;
function stored(
  record: Record<string, unknown>,
  sealedAt: Date,
  checks: Partial<StoredDisputeRecord> = {}
): StoredDisputeRecord {
  next++;
  const wallet = record.kind !== "response" && record.party !== "furnisher";
  return {
    id: next,
    disputeId: String(record.dispute_id),
    kind: String(record.kind),
    record,
    packetId: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    sequence: next,
    sealedAt,
    signatureOk: true,
    subjectControlOk: wallet ? true : null,
    ...checks,
  };
}

const relatingLine = (
  type: "corrects" | "supersedes" | "withdraws",
  sealedAt: Date,
  eventId = `later-${type}`
): Line => ({
  ...LINE,
  id: 100 + ++next,
  eventId,
  signedEventHash: "ef".repeat(32),
  relationType: type,
  relationTargetEventId: LINE.eventId,
  caCreatedAt: sealedAt,
});

const review = (
  line: Line,
  decision: Review["decision"],
  sealedAt: Date,
  reviewerId = "rev_alice"
): Review => ({
  id: sealedAt.getTime(),
  reviewerId,
  decision,
  signedEventHash: line.signedEventHash,
  dataClass: line.dataClass,
  evidenceDigest: evidenceDigest(line.evidenceResult),
  decidedAt: sealedAt,
  sealedAt,
});

// Derived as every settle does: each stored record checked again first.
async function derive(
  records: StoredDisputeRecord[],
  now: Date,
  options: {
    relating?: Line[];
    reviews?: Map<string, Review[]>;
    line?: Line;
  } = {}
) {
  const line = await checkLineDisputes(
    { ...(options.line ?? LINE), disputeRecords: records },
    {}
  );
  return deriveDisputes({
    line,
    records: line.checkedDisputes,
    relating: options.relating ?? [],
    reviewsOf: l => options.reviews?.get(l.eventId) ?? [],
    now,
  });
}

describe("dispute records' signatures", () => {
  it("checks the subject's EIP-191 signature against the wallet the record names", async () => {
    const own = (await filing()) as WalletRecord;
    expect(checkDisputeForm(own).ok).toBe(true);
    expect(await walletSignatureVerifies(own)).toBe(true);
    // Signed by another wallet while naming the subject's.
    const forged = (await filing({}, OTHER_KEY)) as WalletRecord;
    expect(checkDisputeForm(forged).ok).toBe(true);
    expect(await walletSignatureVerifies(forged)).toBe(false);
    // Any change after signing breaks it.
    expect(
      await walletSignatureVerifies({ ...own, reason: "something else" })
    ).toBe(false);
  });

  const keyed = {
    furnisherId: FURNISHER,
    signedEvent: LINE.signedEvent,
    receipt: LINE.receipt,
  };

  it("checks the furnisher's Ed25519 signature against the key that signed the line, from CounterAudit's receipt", () => {
    const record = response() as FurnisherRecord;
    expect(checkFurnisherRecord(record, keyed, {})).toEqual({
      ok: true,
      problem: null,
    });
    const other = response({}, strangerKey.privateKeyPem) as FurnisherRecord;
    expect(checkFurnisherRecord(other, keyed, {})).toEqual({
      ok: false,
      problem: `the signature does not verify with ${FURNISHER}'s key levy-key-1`,
    });
    // The receipt's key counts only for the key id and furnisher it names.
    const receipt = LINE.receipt as { outcome_claim: { signer: object } };
    const renamed = {
      ...keyed,
      receipt: {
        ...receipt,
        outcome_claim: {
          ...receipt.outcome_claim,
          signer: { ...receipt.outcome_claim.signer, key_id: "levy-key-9" },
        },
      },
    };
    expect(checkFurnisherRecord(record, renamed, {}).ok).toBe(false);
  });

  it("or a key server/furnishers.ts lists for the furnisher: active when submitted, and still once revoked", () => {
    const record = response({ key_id: "levy-key-2" }) as FurnisherRecord;
    const listed = (status: "active" | "revoked") => ({
      [FURNISHER]: {
        counterauditOrgId: "11111111-2222-4333-8444-555555555555",
        keys: { "levy-key-2": { publicKey: furnisherKey.publicKey, status } },
      },
    });
    const submitting = { activeKeysOnly: true };
    expect(
      checkFurnisherRecord(record, keyed, listed("active"), submitting).ok
    ).toBe(true);
    expect(
      checkFurnisherRecord(record, keyed, listed("revoked"), submitting)
    ).toEqual({
      ok: false,
      problem: `levy-key-2 is neither the key that signed the line nor an active key server/furnishers.ts lists for ${FURNISHER}`,
    });
    // A stored record keeps checking with a key revoked since it was submitted.
    expect(checkFurnisherRecord(record, keyed, listed("revoked")).ok).toBe(
      true
    );
    expect(checkFurnisherRecord(record, keyed, {})).toMatchObject({
      ok: false,
      problem: `levy-key-2 is neither the key that signed the line nor a key server/furnishers.ts lists for ${FURNISHER}`,
    });
  });

  it("never takes a furnisher's record for another furnisher's line", () => {
    const record = response({
      furnisher_id: "fur_otherfurnisher",
    }) as FurnisherRecord;
    expect(checkFurnisherRecord(record, keyed, {})).toEqual({
      ok: false,
      problem: `the record names fur_otherfurnisher, not the line's furnisher ${FURNISHER}`,
    });
  });
});

describe("control of the subject", () => {
  const sigvara = (agentAddress: string, registeredAt = 1n) =>
    ({
      chainId: async () => 5042002,
      finalizedBlock: async () => ({
        number: 1234n,
        hash: `0x${"11".repeat(32)}`,
        timestamp: 1_793_000_000n,
      }),
      identity: vi.fn(async () => ({
        agentAddress,
        status: 0,
        registeredAt,
      })),
    }) as unknown as SigvaraClient;
  const unused = {} as SigvaraClient;

  it("is the wallet the line names, compared without case", async () => {
    expect(
      await checkSubjectControl(
        { wallet: SUBJECT.toLowerCase() },
        SUBJECT,
        unused
      )
    ).toEqual({ ok: true, problem: null, controller: null });
    expect(
      await checkSubjectControl({ wallet: SUBJECT }, OTHER, unused)
    ).toEqual({
      ok: false,
      problem: `signed by ${OTHER}, not the wallet the line names (${SUBJECT})`,
      controller: null,
    });
  });

  it("is the agent address SigvaraIdentity holds for a did:sigvara, read at the finalized block", async () => {
    const did = { did: `did:sigvara:5042002:${SUBJECT.toLowerCase()}` };
    const chain = sigvara(SUBJECT);
    expect(await checkSubjectControl(did, SUBJECT, chain)).toEqual({
      ok: true,
      problem: null,
      controller: SUBJECT,
    });
    expect(chain.identity).toHaveBeenCalledWith(expect.any(String), 1234n);
    expect(await checkSubjectControl(did, OTHER, chain)).toEqual({
      ok: false,
      problem: `signed by ${OTHER}, not the agent address SigvaraIdentity holds for the did:sigvara (${SUBJECT})`,
      controller: SUBJECT,
    });
    expect(
      await checkSubjectControl(did, SUBJECT, sigvara(SUBJECT, 0n))
    ).toMatchObject({
      ok: false,
      problem: "the agent is not registered in SigvaraIdentity at block 1234",
    });
  });

  it("cannot be shown yet for a registry id or a wallet that is not an EVM address", async () => {
    const registry = await checkSubjectControl(
      { chain: "arc", registry: "agents", id: "42" },
      SUBJECT,
      unused
    );
    expect(registry.ok).toBe(false);
    expect(registry.problem).toContain("Phase 3");
    const solana = await checkSubjectControl(
      { wallet: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV" },
      SUBJECT,
      unused
    );
    expect(solana.ok).toBe(false);
  });
});

describe("what a dispute's records add up to", () => {
  it("is open until 15 days after the dispute was sealed, and lapsed from that moment", async () => {
    const records = [stored(await filing(), T0)];
    const open = await derive(records, at(RESPONSE_DAYS, -1));
    expect(open).toEqual([
      {
        disputeId: ID,
        state: "open",
        filedAt: T0,
        respondBy: at(15),
        confirmedAt: null,
        statement: null,
        appeal: null,
      },
    ]);
    expect((await derive(records, at(15)))[0].state).toBe("lapsed");
  });

  it("shows the line disputed while open, and removed for good once lapsed", async () => {
    const records = [stored(await filing(), T0)];
    const states = async (now: Date, relating: Line[] = []) =>
      lineStates(
        LINE,
        relating,
        [review(LINE, "approve", at(-1))],
        currentDispute(await derive(records, now, { relating }))?.state ?? null
      );
    expect(displayStateFor(await states(at(1)))).toBe("disputed");
    expect((await states(at(1))).released).toBe("solo_test");
    const lapsed = await states(at(15));
    expect(lapsed).toMatchObject({ removed: true, released: null });
    expect(displayStateFor(lapsed)).toBe("removed");
    // The furnisher's route back, a correction after the lapse, never brings the line back.
    const corrected = await states(at(20), [relatingLine("corrects", at(16))]);
    expect(displayStateFor(corrected)).toBe("removed");
  });

  it("leaves a line without a subject dispute exactly as before", async () => {
    const states = lineStates(LINE, [], [], null);
    expect(Object.keys(states)).not.toContain("subject_dispute");
    expect(Object.keys(states)).not.toContain("removed");
    expect(currentDispute(await derive([], at(1)))).toBeNull();
  });

  it("is confirmed by the furnisher's answer within the 15 days, and then takes one statement", async () => {
    const records = [
      stored(await filing(), T0),
      // Before the confirmation: it does not count.
      stored(await statement("too early"), at(1)),
      stored(response(), at(3)),
      stored(await statement(), at(4)),
      stored(await statement("a second one"), at(5)),
    ];
    const [dispute] = await derive(records, at(30));
    expect(dispute).toMatchObject({
      state: "confirmed",
      confirmedAt: at(3),
      statement: "The wallet that paid is not mine.",
    });
    expect(displayStateFor(lineStates(LINE, [], [], dispute.state))).toBe(
      "disputed"
    );
  });

  it("lapses when the furnisher answers after the deadline", async () => {
    const records = [stored(await filing(), T0), stored(response(), at(15, 1))];
    expect((await derive(records, at(16)))[0].state).toBe("lapsed");
  });

  it("closes as corrected or withdrawn by a later line sealed within the 15 days, which outranks a confirmation", async () => {
    const records = [stored(await filing(), T0), stored(response(), at(2))];
    const corrected = await derive(records, at(30), {
      relating: [relatingLine("corrects", at(5))],
    });
    expect(corrected[0].state).toBe("corrected");
    expect(
      (
        await derive(records, at(30), {
          relating: [relatingLine("supersedes", at(5))],
        })
      )[0].state
    ).toBe("corrected");
    const withdrawn = await derive([stored(await filing(), T0)], at(30), {
      relating: [
        relatingLine("corrects", at(4)),
        relatingLine("withdraws", at(5)),
      ],
    });
    expect(withdrawn[0].state).toBe("withdrawn");
    expect(
      displayStateFor(
        lineStates(LINE, [relatingLine("withdraws", at(5))], [], "withdrawn")
      )
    ).toBe("withdrawn");
  });

  it("checks every stored record again, whatever was stored about it", async () => {
    // Signed by another wallet while naming the subject's, stored as if it had checked.
    const forged = stored(await filing({}, OTHER_KEY), T0, {
      signatureOk: true,
      subjectControlOk: true,
    });
    // Signed by another wallet naming itself: not the line's subject.
    const stranger = stored(
      await filing(
        {
          dispute_id: "11111111-2222-4333-8444-555555555555",
          signer: { type: "eip191", address: OTHER },
        },
        OTHER_KEY
      ),
      T0,
      { signatureOk: true, subjectControlOk: true }
    );
    // Edited after it was stored.
    const edited = stored(
      {
        ...(await filing({
          dispute_id: "33333333-2222-4333-8444-555555555555",
        })),
        reason: "edited",
      },
      T0
    );
    const otherVersion = stored(
      await filing({
        dispute_id: "22222222-2222-4333-8444-555555555555",
        line: {
          furnisher_id: FURNISHER,
          event_id: LINE.eventId,
          signed_event_hash: "cd".repeat(32),
        },
      }),
      T0
    );
    const erased = stored(
      await filing({ dispute_id: "44444444-2222-4333-8444-555555555555" }),
      T0
    );
    erased.record = null;
    expect(
      await derive([forged, stranger, edited, otherVersion, erased], at(30))
    ).toEqual([]);
    const keyed = {
      furnisherId: FURNISHER,
      subjectRef: LINE.subjectRef,
      signedEvent: LINE.signedEvent,
      receipt: LINE.receipt,
    };
    expect(await checkStoredRecord(forged, keyed, {})).toEqual({
      ok: false,
      problem: `the signature does not verify as ${SUBJECT}'s`,
      signatureOk: false,
      subjectControlOk: true,
    });
    expect(await checkStoredRecord(erased, keyed, {})).toMatchObject({
      ok: false,
      problem: "the record was erased with the line's source",
    });
    // A response signed with another key confirms nothing, whatever its stored flag says.
    const unconfirmed = [
      stored(await filing(), T0),
      stored(response({}, strangerKey.privateKeyPem), at(2), {
        signatureOk: true,
      }),
    ];
    expect((await derive(unconfirmed, at(30)))[0].state).toBe("lapsed");
    // And a record that checks counts, whatever its stored flags say.
    const flagged = [stored(await filing(), T0, { signatureOk: false })];
    expect((await derive(flagged, at(1)))[0].state).toBe("open");
  });

  it("checks a did:sigvara subject's records against the agent address stored when each was submitted", async () => {
    const did = { did: `did:sigvara:5042002:${SUBJECT.toLowerCase()}` };
    const line = {
      ...LINE,
      subjectRef: did,
      signedEvent: { ...(LINE.signedEvent as object), subject_ref: did },
    };
    const record = await filing({ subject_ref: did });
    const as = (controllerAddress: string | null) =>
      derive([stored(record, T0, { controllerAddress })], at(1), { line });
    expect((await as(SUBJECT))[0].state).toBe("open");
    // Another address, or none read, counts for nothing.
    expect(await as(OTHER)).toEqual([]);
    expect(await as(null)).toEqual([]);
  });
});

describe("appeals", () => {
  const confirmed = async () => [
    stored(await filing(), T0),
    stored(response(), at(2)),
    stored(await subjectAppeal(), at(5)),
  ];

  it("by the subject: open until reviewers decide after it", async () => {
    // A decision sealed before the appeal does not decide it.
    const reviews = new Map([[LINE.eventId, [review(LINE, "approve", at(1))]]]);
    const [dispute] = await derive(await confirmed(), at(6), { reviews });
    expect(dispute.appeal).toEqual({
      party: "subject",
      state: "open",
      sealedAt: at(5),
      packetId: expect.any(String),
      correctiveEventId: null,
    });
  });

  it("by the subject: upheld by a rejection of the line, dismissed by the approvals a release needs", async () => {
    const records = await confirmed();
    const rejected = new Map([
      [
        LINE.eventId,
        [review(LINE, "approve", at(1)), review(LINE, "reject", at(6))],
      ],
    ]);
    const [upheld] = await derive(records, at(7), { reviews: rejected });
    expect(upheld.appeal?.state).toBe("upheld");
    // The rejection holds the line off every file, as any current rejection does.
    expect(
      lineStates(LINE, [], rejected.get(LINE.eventId), upheld.state).released
    ).toBeNull();

    // Test data needs one approval; live data two.
    const approved = new Map([
      [LINE.eventId, [review(LINE, "approve", at(6))]],
    ]);
    expect(
      (await derive(records, at(7), { reviews: approved }))[0].appeal?.state
    ).toBe("dismissed");
  });

  it("by the furnisher, after a lapse: upheld when reviewers release its correction, dismissed when one rejects it", async () => {
    const corrective = relatingLine(
      "corrects",
      at(20),
      "levy-sub8-charge1-fixed"
    );
    const records = [
      stored(await filing(), T0),
      stored(furnisherAppeal(), at(21)),
    ];
    const decide = (decision: Review["decision"]) =>
      new Map([[corrective.eventId, [review(corrective, decision, at(22))]]]);
    const open = (
      await derive(records, at(21, 1), { relating: [corrective] })
    )[0];
    expect(open).toMatchObject({
      state: "lapsed",
      appeal: {
        party: "furnisher",
        state: "open",
        correctiveEventId: corrective.eventId,
      },
    });
    const upheld = (
      await derive(records, at(23), {
        relating: [corrective],
        reviews: decide("approve"),
      })
    )[0];
    expect(upheld.appeal?.state).toBe("upheld");
    expect(
      (
        await derive(records, at(23), {
          relating: [corrective],
          reviews: decide("reject"),
        })
      )[0].appeal?.state
    ).toBe("dismissed");
    // The removed line stays removed either way.
    expect(
      displayStateFor(lineStates(LINE, [corrective], [], upheld.state))
    ).toBe("removed");
  });

  it("by the furnisher: counts only with a line that corrects the removed one", async () => {
    const records = [
      stored(await filing(), T0),
      stored(furnisherAppeal("no-such-line"), at(21)),
    ];
    expect((await derive(records, at(22)))[0].appeal).toBeNull();
  });
});
