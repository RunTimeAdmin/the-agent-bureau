import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import {
  DISPUTE_SCHEMA,
  RESPONSE_DAYS,
  checkDisputeForm,
  checkFurnisherRecord,
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

function derive(
  records: StoredDisputeRecord[],
  now: Date,
  options: { relating?: Line[]; reviews?: Map<string, Review[]> } = {}
) {
  return deriveDisputes({
    line: LINE,
    records,
    relating: options.relating ?? [],
    reviewsOf: line => options.reviews?.get(line.eventId) ?? [],
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
    signedEvent: { key_id: "levy-key-1", furnisher_id: FURNISHER },
    receipt: {
      outcome_claim: { signer: { public_key: furnisherKey.publicKey } },
    },
  };

  it("checks the furnisher's Ed25519 signature against the key that signed the line", () => {
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
  });

  it("or a key server/furnishers.ts lists for the furnisher, while active", () => {
    const record = response({ key_id: "levy-key-2" }) as FurnisherRecord;
    const listed = (status: "active" | "revoked") => ({
      [FURNISHER]: {
        counterauditOrgId: "11111111-2222-4333-8444-555555555555",
        keys: { "levy-key-2": { publicKey: furnisherKey.publicKey, status } },
      },
    });
    expect(checkFurnisherRecord(record, keyed, listed("active")).ok).toBe(true);
    expect(checkFurnisherRecord(record, keyed, listed("revoked"))).toEqual({
      ok: false,
      problem: `levy-key-2 is neither the key that signed the line nor an active key server/furnishers.ts lists for ${FURNISHER}`,
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
      problem: `signed by ${OTHER}, not the agent address SigvaraIdentity holds at block 1234 (${SUBJECT})`,
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
    const open = derive(records, at(RESPONSE_DAYS, -1));
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
    expect(derive(records, at(15))[0].state).toBe("lapsed");
  });

  it("shows the line disputed while open, and removed for good once lapsed", async () => {
    const records = [stored(await filing(), T0)];
    const states = (now: Date, relating: Line[] = []) =>
      lineStates(
        LINE,
        relating,
        [review(LINE, "approve", at(-1))],
        currentDispute(derive(records, now, { relating }))?.state ?? null
      );
    expect(displayStateFor(states(at(1)))).toBe("disputed");
    expect(states(at(1)).released).toBe("solo_test");
    const lapsed = states(at(15));
    expect(lapsed).toMatchObject({ removed: true, released: null });
    expect(displayStateFor(lapsed)).toBe("removed");
    // The furnisher's route back, a correction after the lapse, never brings the line back.
    const corrected = states(at(20), [relatingLine("corrects", at(16))]);
    expect(displayStateFor(corrected)).toBe("removed");
  });

  it("leaves a line without a subject dispute exactly as before", () => {
    const states = lineStates(LINE, [], [], null);
    expect(Object.keys(states)).not.toContain("subject_dispute");
    expect(Object.keys(states)).not.toContain("removed");
    expect(currentDispute(derive([], at(1)))).toBeNull();
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
    const [dispute] = derive(records, at(30));
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
    expect(derive(records, at(16))[0].state).toBe("lapsed");
  });

  it("closes as corrected or withdrawn by a later line sealed within the 15 days, which outranks a confirmation", async () => {
    const records = [stored(await filing(), T0), stored(response(), at(2))];
    const corrected = derive(records, at(30), {
      relating: [relatingLine("corrects", at(5))],
    });
    expect(corrected[0].state).toBe("corrected");
    expect(
      derive(records, at(30), {
        relating: [relatingLine("supersedes", at(5))],
      })[0].state
    ).toBe("corrected");
    const withdrawn = derive([stored(await filing(), T0)], at(30), {
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

  it("counts nothing whose checks failed, or that names another version of the line", async () => {
    const records = [
      stored(await filing(), T0, { signatureOk: false }),
      stored(
        await filing({ dispute_id: "11111111-2222-4333-8444-555555555555" }),
        T0,
        {
          subjectControlOk: false,
        }
      ),
      stored(
        await filing({
          dispute_id: "22222222-2222-4333-8444-555555555555",
          line: {
            furnisher_id: FURNISHER,
            event_id: LINE.eventId,
            signed_event_hash: "cd".repeat(32),
          },
        }),
        T0
      ),
    ];
    expect(derive(records, at(30))).toEqual([]);
    // A response whose signature failed confirms nothing.
    const unconfirmed = [
      stored(await filing(), T0),
      stored(response(), at(2), { signatureOk: false }),
    ];
    expect(derive(unconfirmed, at(30))[0].state).toBe("lapsed");
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
    const [dispute] = derive(await confirmed(), at(6), { reviews });
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
    const [upheld] = derive(records, at(7), { reviews: rejected });
    expect(upheld.appeal?.state).toBe("upheld");
    // The rejection holds the line off every file, as any current rejection does.
    expect(
      lineStates(LINE, [], rejected.get(LINE.eventId), upheld.state).released
    ).toBeNull();

    // Test data needs one approval; live data two.
    const approved = new Map([
      [LINE.eventId, [review(LINE, "approve", at(6))]],
    ]);
    expect(derive(records, at(7), { reviews: approved })[0].appeal?.state).toBe(
      "dismissed"
    );
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
    const open = derive(records, at(21, 1), { relating: [corrective] })[0];
    expect(open).toMatchObject({
      state: "lapsed",
      appeal: {
        party: "furnisher",
        state: "open",
        correctiveEventId: corrective.eventId,
      },
    });
    const upheld = derive(records, at(23), {
      relating: [corrective],
      reviews: decide("approve"),
    })[0];
    expect(upheld.appeal?.state).toBe("upheld");
    expect(
      derive(records, at(23), {
        relating: [corrective],
        reviews: decide("reject"),
      })[0].appeal?.state
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
    expect(derive(records, at(22))[0].appeal).toBeNull();
  });
});
