import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Bureau's lines and decisions, in memory.
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
};
type StoredReview = {
  id: number;
  outcomeEventId: number;
  decisionHash: string;
  signedDecision: unknown;
};
const store = vi.hoisted(() => ({
  rows: [] as Row[],
  reviews: [] as StoredReview[],
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
  listReviewsForLine: vi.fn(async (id: number) =>
    store.reviews
      .filter(r => r.outcomeEventId === id)
      .map(r => ({ id: r.id, signedDecision: r.signedDecision }))
  ),
  insertOutcomeReview: vi.fn(async (row: StoredReview) => {
    if (store.reviews.some(r => r.decisionHash === row.decisionHash))
      return false;
    store.reviews.push({ ...row, id: store.reviews.length + 1 });
    return true;
  }),
  setOutcomeEventDisplayState: vi.fn(async (id: number, state: string) => {
    store.rows.find(r => r.id === id)!.displayState = state;
  }),
}));
vi.mock("./db", () => db);

import { evidenceLabel, runReview, type ReviewIO } from "./review";
import {
  REVIEW_SCHEMA,
  checkReviewDecision,
  evidenceDigest,
  newReviewerKey,
  signReviewDecision,
  type ReviewDecision,
} from "./reviewDecision";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const HASH = "ab".repeat(32);
const EVIDENCE = { status: "verified", reasons: [] };
const alice = newReviewerKey();
const bob = newReviewerKey();
const REVIEWERS = {
  rev_alice: { name: "Alice", publicKey: alice.publicKey },
  rev_bob: { name: "Bob", publicKey: bob.publicKey },
};

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

function decision(
  key: string,
  overrides: Partial<ReviewDecision> = {}
): ReviewDecision {
  return signReviewDecision(
    {
      schema: REVIEW_SCHEMA,
      reviewer_id: "rev_alice",
      furnisher_id: "fur_levymerchant1",
      event_id: "levy-sub8-charge1",
      signed_event_hash: HASH,
      data_class: "test",
      evidence_digest: evidenceDigest(EVIDENCE),
      decision: "approve",
      decided_at: "2026-10-31T11:00:00.000Z",
      ...overrides,
    },
    key
  );
}

function fakeIO(files: Record<string, string> = {}) {
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
    log: line => output.push(line),
    now: () => NOW,
  };
  return { io, written, printed: () => output.join("\n") };
}

const jsonl = (...decisions: ReviewDecision[]) =>
  decisions.map(d => JSON.stringify(d)).join("\n");

beforeEach(() => {
  store.rows = [];
  store.reviews = [];
  vi.stubEnv("DATABASE_URL", "mysql://bureau:secret@127.0.0.1/bureau");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("pnpm review keygen and sign, on the reviewer's machine", () => {
  it("writes a new private key file and prints the public key to list", async () => {
    const { io, written, printed } = fakeIO();
    expect(await runReview(["keygen", "alice.pem"], io, REVIEWERS)).toBe(0);
    expect(written["alice.pem"]).toContain("BEGIN PRIVATE KEY");
    expect(printed()).toMatch(/Public key: ed25519:[A-Za-z0-9_-]{43}/);
    expect(printed()).not.toContain("BEGIN PRIVATE KEY");
    expect(db.schemaReady).not.toHaveBeenCalled();
  });

  it("never overwrites an existing key file", async () => {
    const { io } = fakeIO({ "alice.pem": alice.privateKeyPem });
    expect(await runReview(["keygen", "alice.pem"], io, REVIEWERS)).toBe(2);
  });

  it("signs a decision the Bureau accepts, without touching the database", async () => {
    const { io, printed } = fakeIO({ "alice.pem": alice.privateKeyPem });
    const code = await runReview(
      [
        "sign",
        "--key",
        "alice.pem",
        "--reviewer",
        "rev_alice",
        "--line",
        "fur_levymerchant1/levy-sub8-charge1",
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
      ],
      io,
      REVIEWERS
    );
    expect(code).toBe(0);
    const signed = JSON.parse(printed().split("\n")[0]);
    expect(signed).toMatchObject({
      reviewer_id: "rev_alice",
      decision: "approve_with_waiver",
      reason: "checked the provider log",
      decided_at: NOW.toISOString(),
    });
    expect(checkReviewDecision(signed, REVIEWERS, NOW).ok).toBe(true);
    expect(db.schemaReady).not.toHaveBeenCalled();
  });

  it("refuses to sign as a reviewer whose listed key is another", async () => {
    const { io, printed } = fakeIO({ "bob.pem": bob.privateKeyPem });
    const code = await runReview(
      [
        "sign",
        "--key",
        "bob.pem",
        "--reviewer",
        "rev_alice",
        "--line",
        "fur_levymerchant1/levy-sub8-charge1",
        "--hash",
        HASH,
        "--data-class",
        "test",
        "--evidence",
        evidenceDigest(EVIDENCE),
        "--decision",
        "approve",
      ],
      io,
      REVIEWERS
    );
    expect(code).toBe(2);
    expect(printed()).toBe(
      "This key is not rev_alice's listed key. Nothing signed."
    );
  });
});

describe("pnpm review apply", () => {
  it("records a solo approval of test data and shows the line verified", async () => {
    store.rows.push(row());
    const { io, printed } = fakeIO({
      "d.jsonl": jsonl(decision(alice.privateKeyPem)),
    });

    expect(await runReview(["apply", "d.jsonl"], io, REVIEWERS)).toBe(0);
    expect(store.reviews).toHaveLength(1);
    expect(store.rows[0].displayState).toBe("verified");
    expect(printed()).toContain(
      "line 1: rev_alice approve fur_levymerchant1/levy-sub8-charge1: recorded; released by one reviewer (test data); shown verified"
    );
  });

  it("holds a live line until a second reviewer approves", async () => {
    store.rows.push(row({ dataClass: "live" }));
    const first = fakeIO({
      "d.jsonl": jsonl(decision(alice.privateKeyPem, { data_class: "live" })),
    });
    await runReview(["apply", "d.jsonl"], first.io, REVIEWERS);
    expect(store.rows[0].displayState).toBe("unverified");
    expect(first.printed()).toContain(
      "recorded; not released: needs 1 more approval from different reviewers; shown unverified"
    );

    const second = fakeIO({
      "d.jsonl": jsonl(
        decision(bob.privateKeyPem, {
          reviewer_id: "rev_bob",
          data_class: "live",
        })
      ),
    });
    await runReview(["apply", "d.jsonl"], second.io, REVIEWERS);
    expect(store.rows[0].displayState).toBe("verified");
    expect(second.printed()).toContain("recorded; released; shown verified");
  });

  it("records the same decision once", async () => {
    store.rows.push(row());
    const signed = decision(alice.privateKeyPem);
    const { io, printed } = fakeIO({ "d.jsonl": jsonl(signed, signed) });

    expect(await runReview(["apply", "d.jsonl"], io, REVIEWERS)).toBe(0);
    expect(store.reviews).toHaveLength(1);
    expect(printed()).toContain(
      "line 2: rev_alice approve fur_levymerchant1/levy-sub8-charge1: already recorded"
    );
  });

  it("refuses decisions it cannot tie to a listed reviewer and a stored event, and exits 1", async () => {
    store.rows.push(row());
    const mallory = newReviewerKey();
    const { io, printed } = fakeIO({
      "d.jsonl": [
        jsonl(decision(mallory.privateKeyPem, { reviewer_id: "rev_mallory" })),
        jsonl(decision(mallory.privateKeyPem)),
        jsonl(
          decision(alice.privateKeyPem, { signed_event_hash: "cd".repeat(32) })
        ),
        jsonl(decision(alice.privateKeyPem, { event_id: "no-such-event" })),
        "not json",
      ].join("\n"),
    });

    expect(await runReview(["apply", "d.jsonl"], io, REVIEWERS)).toBe(1);
    expect(store.reviews).toHaveLength(0);
    expect(store.rows[0].displayState).toBe("unverified");
    const out = printed();
    expect(out).toContain(
      "line 1: refused: rev_mallory is not a listed reviewer"
    );
    expect(out).toContain(
      "line 2: refused: the signature does not verify with rev_alice's key"
    );
    expect(out).toContain(
      "line 3: rev_alice approve fur_levymerchant1/levy-sub8-charge1: refused, signed_event_hash is not the stored event's"
    );
    expect(out).toContain(
      "line 4: rev_alice approve fur_levymerchant1/no-such-event: refused, the Bureau holds no such line"
    );
    expect(out).toContain("line 5: refused: not valid JSON");
  });

  it("takes a release back when a reviewer later rejects", async () => {
    store.rows.push(row());
    const { io } = fakeIO({
      "d.jsonl": jsonl(
        decision(alice.privateKeyPem),
        decision(alice.privateKeyPem, {
          decision: "reject",
          reason: "the subject is not the payer",
          decided_at: "2026-10-31T11:30:00.000Z",
        })
      ),
    });
    await runReview(["apply", "d.jsonl"], io, REVIEWERS);
    expect(store.rows[0].displayState).toBe("unverified");
  });

  it("needs DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { io, printed } = fakeIO({ "d.jsonl": "" });
    expect(await runReview(["apply", "d.jsonl"], io, REVIEWERS)).toBe(2);
    expect(printed()).toContain("Not set: DATABASE_URL");
  });
});

describe("pnpm review queue and settle", () => {
  it("names what a payment line's evidence proved, and what it does not", async () => {
    store.rows.push(row({ evidenceStatus: "verified", outcome: "paid" }));
    const { io, printed } = fakeIO();
    expect(await runReview(["queue"], io, REVIEWERS)).toBe(0);
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

  it("lists each open line with its hash and what holds it back", async () => {
    store.rows.push(
      row({
        evidenceStatus: "needs_review",
        evidenceResult: {
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
    const { io, printed } = fakeIO();

    expect(await runReview(["queue"], io, REVIEWERS)).toBe(0);
    const out = printed();
    expect(out).toContain(
      "fur_levymerchant1/levy-sub8-charge1  delivered  test data  shown unverified"
    );
    expect(out).toContain(`  hash ${HASH}`);
    expect(out).toContain(
      "evidence needs_review: no machine check exists for delivered outcomes"
    );
    expect(out).toContain(
      "review: needs 2 more approvals that waive the evidence from different reviewers (test data: one is enough)"
    );
    expect(out).toContain(
      "3 lines: 2 waiting, 0 released, 1 withdrawn or superseded. Listed reviewers: 2."
    );
    expect(out).not.toContain("fur_levymerchant1/gone ");
    expect(out).toContain(
      `  sign with: --line fur_levymerchant1/levy-sub8-charge1 --hash ${HASH} --data-class test --evidence ${evidenceDigest({ reasons: ["no machine check exists for delivered outcomes"] })}`
    );
  });

  it("re-settles every line, so a reviewer taken off the list stops counting", async () => {
    store.rows.push(row());
    const { io } = fakeIO({ "d.jsonl": jsonl(decision(alice.privateKeyPem)) });
    await runReview(["apply", "d.jsonl"], io, REVIEWERS);
    expect(store.rows[0].displayState).toBe("verified");

    const after = fakeIO();
    expect(
      await runReview(["settle"], after.io, { rev_bob: REVIEWERS.rev_bob })
    ).toBe(0);
    expect(store.rows[0].displayState).toBe("unverified");
    expect(after.printed()).toContain(
      "fur_levymerchant1/levy-sub8-charge1: verified -> unverified"
    );
  });
});

describe("what pnpm review trusts", () => {
  it("never counts a recorded row whose signed form does not check out", async () => {
    store.rows.push(row({ dataClass: "live" }));
    const signed = decision(alice.privateKeyPem, { data_class: "live" });
    const { io } = fakeIO({ "d.jsonl": jsonl(signed) });
    await runReview(["apply", "d.jsonl"], io, REVIEWERS);
    // Someone with database access copies Alice's decision in as Bob's, and
    // adds a row whose signed form is not even JSON.
    store.reviews.push(
      {
        id: 98,
        outcomeEventId: 1,
        decisionHash: "x",
        signedDecision: { ...signed, reviewer_id: "rev_bob" },
      },
      {
        id: 99,
        outcomeEventId: 1,
        decisionHash: "y",
        signedDecision: "not json",
      }
    );
    const after = fakeIO();
    await runReview(["settle"], after.io, REVIEWERS);
    expect(store.rows[0].displayState).toBe("unverified");
  });

  it("stops counting decisions signed with a key since replaced", async () => {
    store.rows.push(row());
    const { io } = fakeIO({ "d.jsonl": jsonl(decision(alice.privateKeyPem)) });
    await runReview(["apply", "d.jsonl"], io, REVIEWERS);
    expect(store.rows[0].displayState).toBe("verified");

    const rekeyed = {
      ...REVIEWERS,
      rev_alice: { name: "Alice", publicKey: newReviewerKey().publicKey },
    };
    await runReview(["settle"], fakeIO().io, rekeyed);
    expect(store.rows[0].displayState).toBe("unverified");
  });

  it("refuses an approval signed for another data class or for evidence that has since changed", async () => {
    store.rows.push(row());
    const { io, printed } = fakeIO({
      "d.jsonl": jsonl(
        decision(alice.privateKeyPem, { data_class: "live" }),
        decision(alice.privateKeyPem, { evidence_digest: "ef".repeat(32) }),
        decision(alice.privateKeyPem, {
          decision: "reject",
          reason: "looked again",
          evidence_digest: "ef".repeat(32),
        })
      ),
    });

    expect(await runReview(["apply", "d.jsonl"], io, REVIEWERS)).toBe(1);
    const out = printed();
    expect(out).toContain(
      "line 1: rev_alice approve fur_levymerchant1/levy-sub8-charge1: refused, it was signed for live data and the line is test"
    );
    expect(out).toContain(
      "line 2: rev_alice approve fur_levymerchant1/levy-sub8-charge1: refused, the line's evidence changed since it was signed"
    );
    // A rejection holds whatever it was signed against.
    expect(out).toContain(
      "line 3: rev_alice reject fur_levymerchant1/levy-sub8-charge1: recorded; not released: rejected by rev_alice"
    );
  });

  it("refuses to run with two reviewer ids on one key", async () => {
    const { io, printed } = fakeIO();
    const doubled = {
      ...REVIEWERS,
      rev_alias: { name: "Alias", publicKey: alice.publicKey },
    };
    expect(await runReview(["queue"], io, doubled)).toBe(2);
    expect(printed()).toBe(
      "The reviewer list is unusable: rev_alice and rev_alias list the same public key"
    );
  });
});
