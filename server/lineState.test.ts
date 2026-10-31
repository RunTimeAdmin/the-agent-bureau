import { describe, expect, it } from "vitest";
import {
  displayStateFor,
  lineStates,
  relationProblem,
  releaseFor,
  type Line,
  type Review,
} from "./lineState";
import { evidenceDigest } from "./reviewDecision";

const WALLET = "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77";

function line(overrides: Partial<Line> = {}): Line {
  return {
    id: 1,
    furnisherId: "fur_levymerchant1",
    eventId: "charge-8-1",
    subjectRef: { wallet: WALLET },
    dataClass: "test",
    proofOk: true,
    evidenceStatus: null,
    evidenceResult: null,
    signedEventHash: "a".repeat(64),
    displayState: "unverified",
    relationType: null,
    relationTargetEventId: null,
    ...overrides,
  };
}

let nextId = 2;
function relating(type: Line["relationType"], overrides: Partial<Line> = {}) {
  const id = nextId++;
  return line({
    id,
    eventId: `later-${id}`,
    relationType: type,
    relationTargetEventId: "charge-8-1",
    ...overrides,
  });
}

describe("lineStates", () => {
  it("keeps sealed, source signed and evidence verified apart", () => {
    expect(lineStates(line({ proofOk: false }), [])).toEqual({
      sealed: true,
      source_signed: false,
      evidence_verified: false,
      disputed: false,
      withdrawn: false,
      superseded: false,
      released: null,
    });
    expect(lineStates(line({ evidenceStatus: "verified" }), [])).toMatchObject({
      source_signed: true,
      evidence_verified: true,
    });
    expect(
      lineStates(line({ evidenceStatus: "needs_review" }), [])
    ).toMatchObject({ evidence_verified: false });
  });

  it.each([
    ["withdraws", { withdrawn: true }, "withdrawn"],
    ["supersedes", { superseded: true }, "superseded"],
    ["corrects", { superseded: true }, "superseded"],
    ["disputes", { disputed: true }, "disputed"],
  ] as const)("a later %s line marks the target", (type, states, display) => {
    const result = lineStates(line(), [relating(type)]);
    expect(result).toMatchObject(states);
    expect(displayStateFor(result)).toBe(display);
  });

  it("ranks a withdrawal over a replacement over a dispute", () => {
    const all = [
      relating("disputes"),
      relating("corrects"),
      relating("withdraws"),
    ];
    expect(displayStateFor(lineStates(line(), all))).toBe("withdrawn");
    expect(displayStateFor(lineStates(line(), all.slice(0, 2)))).toBe(
      "superseded"
    );
    expect(displayStateFor(lineStates(line(), []))).toBe("unverified");
  });

  it("drops a dispute the furnisher has withdrawn, but not a withdrawn correction or withdrawal", () => {
    const withdrawn = { displayState: "withdrawn" as const };
    expect(lineStates(line(), [relating("disputes", withdrawn)]).disputed).toBe(
      false
    );
    expect(
      lineStates(line(), [relating("corrects", withdrawn)]).superseded
    ).toBe(true);
    expect(
      lineStates(line(), [relating("withdraws", withdrawn)]).withdrawn
    ).toBe(true);
    // A dispute that is itself disputed or superseded still stands.
    expect(
      lineStates(line(), [relating("disputes", { displayState: "disputed" })])
        .disputed
    ).toBe(true);
  });

  it("does not return verified without a release, even when every check passed", () => {
    const states = lineStates(line({ evidenceStatus: "verified" }), []);
    expect(displayStateFor(states)).toBe("unverified");
  });
});

describe("relationProblem", () => {
  it("lets a signed line about the same subject act", () => {
    expect(relationProblem(relating("withdraws"), line())).toBeNull();
  });

  it("reads a subject that an older MariaDB returned as JSON text", () => {
    const asText = line({
      subjectRef: JSON.stringify({
        wallet: WALLET,
      }) as unknown as Line["subjectRef"],
    });
    expect(relationProblem(relating("withdraws"), asText)).toBeNull();
  });

  it("matches a wallet subject without case", () => {
    const lower = relating("withdraws", {
      subjectRef: { wallet: WALLET.toLowerCase() },
    });
    expect(relationProblem(lower, line())).toBeNull();
  });

  it.each([
    [
      "a line whose own proof has not passed",
      { proofOk: false },
      "its own proof has not passed",
    ],
    [
      "a line about a different subject",
      { subjectRef: { wallet: "0x451567A35648445143768d3D6e9072A50BB2d85F" } },
      "it names a different subject",
    ],
    [
      "a DID subject against a wallet subject",
      { subjectRef: { did: `did:sigvara:5042002:${WALLET}` } },
      "it names a different subject",
    ],
    [
      "a live line acting on a test line",
      { dataClass: "live" as const },
      "a live line cannot act on a test line",
    ],
  ])("stops %s", (_name, overrides, problem) => {
    const r = relating("withdraws", overrides);
    expect(relationProblem(r, line())).toBe(problem);
    expect(lineStates(line(), [r]).withdrawn).toBe(false);
  });

  it("ignores a line whose relation points at itself", () => {
    const self = line({
      relationType: "withdraws",
      relationTargetEventId: "charge-8-1",
    });
    expect(relationProblem(self, self)).toBe("it points at itself");
    expect(lineStates(self, [self]).withdrawn).toBe(false);
  });
});

describe("releaseFor: two-person review", () => {
  const HASH = "a".repeat(64);
  const EVIDENCE = { status: "verified", reasons: [] };
  let id = 100;
  // A decision as re-read from its signed form, about the test line below
  // unless overridden.
  function review(
    reviewerId: string,
    decision: Review["decision"],
    overrides: Partial<Omit<Review, "decidedAt">> & { decidedAt?: string } = {}
  ): Review {
    const { decidedAt = "2026-10-31T10:00:00.000Z", ...rest } = overrides;
    return {
      id: id++,
      reviewerId,
      decision,
      signedEventHash: HASH,
      dataClass: "test",
      evidenceDigest: evidenceDigest(EVIDENCE),
      decidedAt: new Date(decidedAt),
      ...rest,
    };
  }
  const live = line({
    dataClass: "live",
    evidenceStatus: "verified",
    evidenceResult: EVIDENCE,
  });
  const test = line({
    dataClass: "test",
    evidenceStatus: "verified",
    evidenceResult: EVIDENCE,
  });
  const onLive = { dataClass: "live" as const };

  it("releases a live line only with two different reviewers", () => {
    expect(releaseFor(live, [review("rev_alice", "approve", onLive)])).toEqual({
      released: null,
      holdingBack: "needs 1 more approval from different reviewers",
    });
    const sameTwice = [
      review("rev_alice", "approve", onLive),
      review("rev_alice", "approve", {
        ...onLive,
        decidedAt: "2026-10-31T11:00:00.000Z",
      }),
    ];
    expect(releaseFor(live, sameTwice).released).toBeNull();
    const two = [
      review("rev_alice", "approve", onLive),
      review("rev_bob", "approve", onLive),
    ];
    expect(releaseFor(live, two).released).toBe("two_person");
    expect(displayStateFor(lineStates(live, [], two))).toBe("verified");
  });

  it("lets one reviewer release test data, flagged as solo", () => {
    const one = [review("rev_alice", "approve")];
    expect(releaseFor(test, one).released).toBe("solo_test");
    expect(displayStateFor(lineStates(test, [], one))).toBe("verified");
    expect(releaseFor(test, []).holdingBack).toBe(
      "needs 2 more approvals from different reviewers (test data: one is enough)"
    );
  });

  it("counts only decisions signed for the line's data class", () => {
    expect(
      releaseFor(live, [
        review("rev_alice", "approve"),
        review("rev_bob", "approve"),
      ]).released
    ).toBeNull();
    expect(
      releaseFor(test, [review("rev_alice", "approve", onLive)]).released
    ).toBeNull();
  });

  it("holds a line any reviewer currently rejects", () => {
    const decisions = [
      review("rev_alice", "approve", onLive),
      review("rev_bob", "approve", onLive),
      review("rev_carol", "reject", onLive),
    ];
    expect(releaseFor(live, decisions)).toEqual({
      released: null,
      holdingBack: "rejected by rev_carol",
    });
  });

  it("counts each reviewer's latest signed decision, whatever order they were recorded in", () => {
    const changedMind = [
      review("rev_carol", "reject", { decidedAt: "2026-10-31T09:00:00.000Z" }),
      review("rev_carol", "approve", { decidedAt: "2026-10-31T10:00:00.000Z" }),
    ];
    expect(releaseFor(test, changedMind).released).toBe("solo_test");
    // An older approval recorded after a newer rejection does not undo it.
    const replayed = [
      review("rev_carol", "reject", { decidedAt: "2026-10-31T10:00:00.000Z" }),
      review("rev_carol", "approve", { decidedAt: "2026-10-31T09:00:00.000Z" }),
    ];
    expect(releaseFor(test, replayed).holdingBack).toBe(
      "rejected by rev_carol"
    );
  });

  it("needs approvals that waive evidence a person must judge", () => {
    const evidence = {
      status: "needs_review",
      reasons: ["no machine check exists for delivered outcomes"],
    };
    const unchecked = line({
      dataClass: "live",
      evidenceStatus: "needs_review",
      evidenceResult: evidence,
    });
    const digest = { ...onLive, evidenceDigest: evidenceDigest(evidence) };
    expect(
      releaseFor(unchecked, [
        review("rev_alice", "approve", digest),
        review("rev_bob", "approve", digest),
      ]).holdingBack
    ).toBe(
      "needs 2 more approvals that waive the evidence from different reviewers"
    );
    expect(
      releaseFor(unchecked, [
        review("rev_alice", "approve_with_waiver", digest),
        review("rev_bob", "approve_with_waiver", digest),
      ]).released
    ).toBe("two_person");
  });

  it("drops approvals once the evidence changes, but keeps a rejection", () => {
    const before = {
      status: "needs_review",
      reasons: ["the subject is not an EVM wallet"],
    };
    const after = {
      ...before,
      reasons: [
        ...before.reasons,
        "the same charge already backs fur_other01/e1",
      ],
    };
    const changed = line({
      dataClass: "live",
      evidenceStatus: "needs_review",
      evidenceResult: after,
    });
    const stale = { ...onLive, evidenceDigest: evidenceDigest(before) };
    expect(
      releaseFor(changed, [
        review("rev_alice", "approve_with_waiver", stale),
        review("rev_bob", "approve_with_waiver", stale),
      ]).released
    ).toBeNull();
    expect(
      releaseFor(changed, [review("rev_carol", "reject", stale)]).holdingBack
    ).toBe("rejected by rev_carol");
  });

  it.each([
    [
      "failed evidence, which cannot be waived",
      { evidenceStatus: "failed" as const },
      "its evidence check failed, which cannot be waived",
    ],
    [
      "evidence not checked yet",
      { evidenceStatus: "pending" as const },
      "its evidence is pending; run the intake again",
    ],
    [
      "a proof that has not passed",
      { proofOk: false },
      "its proof has not passed",
    ],
  ])("never releases a line with %s", (_name, overrides, holdingBack) => {
    const all = [
      review("rev_alice", "approve_with_waiver"),
      review("rev_bob", "approve_with_waiver"),
    ];
    expect(
      releaseFor(
        line({ dataClass: "test", evidenceResult: EVIDENCE, ...overrides }),
        all
      )
    ).toEqual({
      released: null,
      holdingBack,
    });
  });

  it("ignores decisions about a different version of the event", () => {
    const other = [
      review("rev_alice", "approve", { signedEventHash: "b".repeat(64) }),
    ];
    expect(releaseFor(test, other).released).toBeNull();
  });

  it("shows a dispute or withdrawal over a release", () => {
    const one = [review("rev_alice", "approve")];
    expect(displayStateFor(lineStates(test, [relating("disputes")], one))).toBe(
      "disputed"
    );
    expect(
      displayStateFor(lineStates(test, [relating("withdraws")], one))
    ).toBe("withdrawn");
  });
});
