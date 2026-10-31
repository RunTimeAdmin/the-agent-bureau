import { describe, expect, it } from "vitest";
import {
  REVIEWER_KEY_SCHEMA,
  checkKeyRecordForm,
  genesisHash,
  keyRecordVerifies,
  replayReviewLog,
  signKeyRecord,
  type KeyChange,
  type LogRecord,
} from "./reviewLog";
import {
  REVIEW_SCHEMA,
  newReviewerKey,
  signReviewDecision,
  type ReviewDecision,
} from "./reviewDecision";

const SEALED = new Date("2026-10-31T12:00:00.000Z");
const people = {
  alice: newReviewerKey(),
  bob: newReviewerKey(),
  carol: newReviewerKey(),
  dave: newReviewerKey(),
};
type Person = keyof typeof people;
const TEAM = (["alice", "bob", "carol"] as const).map(p => ({
  reviewer_id: `rev_${p}`,
  name: p,
  public_key: people[p].publicKey,
}));
const PIN = genesisHash(TEAM);

function keyRecord(
  signer: Person,
  change: KeyChange,
  options: { key?: string; decidedAt?: string } = {}
) {
  return signKeyRecord(
    {
      schema: REVIEWER_KEY_SCHEMA,
      signer_id: `rev_${signer}`,
      change,
      decided_at: options.decidedAt ?? "2026-10-31T11:00:00.000Z",
    },
    options.key ?? people[signer].privateKeyPem
  );
}

function decision(
  reviewer: Person,
  overrides: Partial<ReviewDecision> = {},
  key: string = people[reviewer].privateKeyPem
) {
  return signReviewDecision(
    {
      schema: REVIEW_SCHEMA,
      reviewer_id: `rev_${reviewer}`,
      furnisher_id: "fur_levymerchant1",
      event_id: "levy-sub8-charge1",
      signed_event_hash: "ab".repeat(32),
      data_class: "live",
      evidence_digest: "cd".repeat(32),
      decision: "approve",
      decided_at: "2026-10-31T11:00:00.000Z",
      ...overrides,
    },
    key
  );
}

const genesis = (): KeyChange => ({ type: "genesis", reviewers: TEAM });
const signedGenesis = () =>
  (["alice", "bob", "carol"] as const).map(p => keyRecord(p, genesis()));

// Records in the order sealed, from sequence 0, replayed with TEAM's genesis pinned.
const chain = (...records: unknown[]): LogRecord[] =>
  records.map((record, sequence) => ({
    sequence,
    packetId: `packet-${sequence}`,
    sealedAt: SEALED,
    record,
  }));
const replay = (...records: unknown[]) => replayReviewLog(chain(...records), PIN);

const statusOf = (records: unknown[], id: string) =>
  replay(...records).reviewers?.get(id)?.status;
const counted = (records: unknown[]) =>
  replay(...records).decisions.map(
    d => `${d.decision.reviewer_id}${d.suspended ? " (suspended)" : ""}`
  );
const lastEvent = (records: unknown[]) => replay(...records).events.at(-1)!.text;

describe("reviewer-key records", () => {
  it("signs a record whose form checks and whose signature verifies only with the signer's key", () => {
    const record = keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" });
    expect(checkKeyRecordForm(record).ok).toBe(true);
    expect(keyRecordVerifies(record, people.alice.publicKey)).toBe(true);
    expect(keyRecordVerifies(record, people.bob.publicKey)).toBe(false);
    const altered = { ...record, change: { type: "suspend", reviewer_id: "rev_carol" } } as typeof record;
    expect(keyRecordVerifies(altered, people.alice.publicKey)).toBe(false);
  });

  it("refuses records outside the form", () => {
    const good = keyRecord("alice", { type: "remove", reviewer_id: "rev_bob" });
    const reasons = [
      { ...good, extra: 1 },
      { ...good, schema: REVIEW_SCHEMA },
      { ...good, signer_id: "alice" },
      { ...good, change: { type: "remove", reviewer_id: "rev_bob", name: "x" } },
      { ...good, change: { type: "promote", reviewer_id: "rev_bob" } },
      { ...good, change: { type: "genesis", reviewers: TEAM.slice(0, 2) } },
      { ...good, change: { type: "genesis", reviewers: [TEAM[0], TEAM[0], TEAM[1]] } },
      { ...good, change: { type: "add", reviewer_id: "rev_dave", name: "Dave", public_key: "ed25519:short" } },
      { ...good, decided_at: "2026-10-31T11:00:00Z" },
      { ...good, signature: `${good.signature}A` },
    ].map(value => {
      const result = checkKeyRecordForm(value);
      return result.ok ? "ok" : result.reason;
    });
    expect(reasons).not.toContain("ok");
  });

  it("takes a public key only in its canonical spelling, so one key cannot pass as two", () => {
    const twice = [TEAM[0], { ...TEAM[1], public_key: `${TEAM[0].public_key} ` }, TEAM[2]];
    expect(checkKeyRecordForm(keyRecord("alice", { type: "genesis", reviewers: twice }))).toEqual({
      ok: false,
      reason: "each genesis reviewer needs a rev_ id, a name and an ed25519 public key",
    });
  });
});

describe("replaying the review log", () => {
  it("takes the pinned genesis once every reviewer it names has signed it, and counts no decision before", () => {
    const [a, b, c] = signedGenesis();
    expect(replay(a, b, decision("alice")).reviewers).toBeNull();
    expect(counted([a, b, decision("alice")])).toEqual([]);

    const log = replay(a, b, c, decision("alice"));
    expect([...log.reviewers!.keys()]).toEqual(["rev_alice", "rev_bob", "rev_carol"]);
    expect(log.decisions.map(d => d.packetId)).toEqual(["packet-3"]);
    expect(log.events.at(-1)).toEqual({
      sequence: 2,
      text: "genesis of rev_alice, rev_bob, rev_carol took effect, signed by all of them",
    });
    expect(log.readTo).toBe(3);
  });

  it("takes no genesis but the pinned one, so one sealed first by someone else counts for nothing", () => {
    expect(replayReviewLog(chain(...signedGenesis()), null).reviewers).toBeNull();

    // The same ids and names with keys someone else holds, sealed before the real one.
    const fakeKeys = [0, 1, 2].map(() => newReviewerKey());
    const impostors = TEAM.map((r, i) => ({ ...r, public_key: fakeKeys[i].publicKey }));
    const sealedFirst = (["alice", "bob", "carol"] as const).map((p, i) =>
      keyRecord(p, { type: "genesis", reviewers: impostors }, { key: fakeKeys[i].privateKeyPem })
    );
    const log = replay(...sealedFirst, ...signedGenesis());
    expect(log.events[0].text).toBe("ignored, not the genesis pinned in server/reviewLog.ts");
    expect(log.reviewers!.get("rev_alice")!.publicKey).toBe(people.alice.publicKey);
  });

  it("counts only test-data decisions while the pinned genesis is the operator-held testnet one", () => {
    const records = chain(...signedGenesis(), decision("alice"), decision("bob", { data_class: "test" }));
    const testnet = replayReviewLog(records, PIN, PIN);
    expect(testnet.testnet).toBe(true);
    expect(testnet.decisions.map(d => d.decision.reviewer_id)).toEqual(["rev_bob"]);
    const independent = replayReviewLog(records, PIN, null);
    expect(independent.testnet).toBe(false);
    expect(independent.decisions.map(d => d.decision.reviewer_id)).toEqual(["rev_alice", "rev_bob"]);
  });

  it("counts a decision sealed before the genesis took effect, once it has", () => {
    const [a, b, c] = signedGenesis();
    expect(counted([a, decision("bob"), b, c])).toEqual(["rev_bob"]);
  });

  it("ignores a genesis signature made with another key, and any genesis after the first", () => {
    const [a, b] = signedGenesis();
    const forged = keyRecord("carol", genesis(), { key: people.dave.privateKeyPem });
    expect(replay(a, b, forged).reviewers).toBeNull();
    expect(lastEvent([...signedGenesis(), ...signedGenesis()])).toBe(
      "ignored, a genesis after the first counts for nothing"
    );
  });

  it("lets one reviewer suspend another at once, and holds the suspended reviewer's decision", () => {
    const suspend = keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" });
    expect(statusOf([...signedGenesis(), suspend], "rev_bob")).toBe("suspended");
    expect(counted([...signedGenesis(), decision("bob"), suspend])).toEqual(["rev_bob (suspended)"]);
  });

  it("needs two different reviewers to add, and counts one reviewer's two votes once", () => {
    const add: KeyChange = {
      type: "add",
      reviewer_id: "rev_dave",
      name: "Dave",
      public_key: people.dave.publicKey,
    };
    const once = keyRecord("alice", add);
    const again = keyRecord("alice", add, { decidedAt: "2026-10-31T11:01:00.000Z" });
    expect(statusOf([...signedGenesis(), once, again], "rev_dave")).toBeUndefined();
    expect(statusOf([...signedGenesis(), once, keyRecord("bob", add)], "rev_dave")).toBe("active");
    // A vote for a different change (another name) is not a vote for this one.
    const renamed = keyRecord("bob", { ...add, name: "David" } as KeyChange);
    expect(statusOf([...signedGenesis(), once, renamed], "rev_dave")).toBeUndefined();
  });

  it("keeps a suspended reviewer's vote, so one key cannot suspend the others out of the quorum", () => {
    const records = [
      ...signedGenesis(),
      keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }),
      keyRecord("alice", { type: "suspend", reviewer_id: "rev_carol" }),
      keyRecord("bob", { type: "remove", reviewer_id: "rev_alice" }),
      keyRecord("carol", { type: "remove", reviewer_id: "rev_alice" }),
      keyRecord("bob", { type: "reenable", reviewer_id: "rev_bob" }),
      keyRecord("carol", { type: "reenable", reviewer_id: "rev_bob" }),
      keyRecord("bob", { type: "reenable", reviewer_id: "rev_carol" }),
      keyRecord("carol", { type: "reenable", reviewer_id: "rev_carol" }),
    ];
    const log = replay(...records);
    expect([...log.reviewers!.entries()].map(([id, r]) => `${id} ${r.status}`)).toEqual([
      "rev_alice removed",
      "rev_bob active",
      "rev_carol active",
    ]);
    // A removed reviewer has no vote left.
    expect(lastEvent([...records, keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" })])).toBe(
      "ignored, not signed by a reviewer with their current key"
    );
  });

  it("counts a vote only toward the reviewers as they stood when it was cast", () => {
    const fresh = newReviewerKey();
    const rotate: KeyChange = { type: "rotate", reviewer_id: "rev_bob", public_key: fresh.publicKey };
    const reenable: KeyChange = { type: "reenable", reviewer_id: "rev_bob" };
    const records = [
      ...signedGenesis(),
      keyRecord("carol", { type: "suspend", reviewer_id: "rev_bob" }),
      keyRecord("alice", reenable),
      // The reviewers rotate Bob's key instead, which settles the suspension.
      keyRecord("alice", rotate),
      keyRecord("carol", rotate),
      // A later incident: Alice suspends Bob again, and Carol alone votes to re-enable him.
      keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }),
      keyRecord("carol", reenable),
    ];
    expect(statusOf(records, "rev_bob")).toBe("suspended");
    expect(lastEvent(records)).toBe("rev_carol voted to reenable rev_bob (1 of 2)");
  });

  it("counts a key record sealed again for nothing, so a leaked old key cannot be rotated back", () => {
    const k1 = newReviewerKey();
    const k2 = newReviewerKey();
    const toK1: KeyChange = { type: "rotate", reviewer_id: "rev_bob", public_key: k1.publicKey };
    const toK2: KeyChange = { type: "rotate", reviewer_id: "rev_bob", public_key: k2.publicKey };
    const first = [keyRecord("alice", toK1), keyRecord("carol", toK1)];
    const records = [...signedGenesis(), ...first, keyRecord("alice", toK2), keyRecord("carol", toK2), ...first];
    expect(replay(...records).reviewers!.get("rev_bob")!.publicKey).toBe(k2.publicKey);
    expect(lastEvent(records)).toBe("ignored, sealed before");
  });

  it("ignores a key record sealed more than a day after it was signed", () => {
    const stale = keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }, { decidedAt: "2026-10-30T11:59:00.000Z" });
    expect(statusOf([...signedGenesis(), stale], "rev_bob")).toBe("active");
    expect(lastEvent([...signedGenesis(), stale])).toBe("ignored, sealed more than a day after it was signed");
  });

  it("re-enables a suspended reviewer with two votes, after which their decision counts again", () => {
    const records = [
      ...signedGenesis(),
      decision("bob"),
      keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }),
      keyRecord("alice", { type: "reenable", reviewer_id: "rev_bob" }),
    ];
    expect(counted(records)).toEqual(["rev_bob (suspended)"]);
    records.push(keyRecord("carol", { type: "reenable", reviewer_id: "rev_bob" }));
    expect(counted(records)).toEqual(["rev_bob"]);
  });

  it("stops counting decisions signed with a key since rotated, and settles a suspension", () => {
    const fresh = newReviewerKey();
    const rotate: KeyChange = { type: "rotate", reviewer_id: "rev_bob", public_key: fresh.publicKey };
    const records = [
      ...signedGenesis(),
      decision("bob"),
      keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }),
      keyRecord("alice", rotate),
      keyRecord("carol", rotate),
      decision("bob", { decided_at: "2026-10-31T11:30:00.000Z" }, fresh.privateKeyPem),
    ];
    const log = replay(...records);
    expect(log.reviewers!.get("rev_bob")).toMatchObject({ status: "active", publicKey: fresh.publicKey });
    expect(log.decisions.map(d => d.packetId)).toEqual(["packet-7"]);
  });

  it("drops a removed reviewer's decisions", () => {
    const remove: KeyChange = { type: "remove", reviewer_id: "rev_carol" };
    expect(
      counted([...signedGenesis(), decision("carol"), keyRecord("alice", remove), keyRecord("bob", remove)])
    ).toEqual([]);
  });

  it("ignores a decision copied under another reviewer's id, and a record dated after it was sealed", () => {
    const copied = { ...decision("alice"), reviewer_id: "rev_bob" };
    expect(counted([...signedGenesis(), copied])).toEqual([]);

    const late = keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }, { decidedAt: "2026-10-31T12:06:00.000Z" });
    expect(statusOf([...signedGenesis(), late], "rev_bob")).toBe("active");
    expect(lastEvent([...signedGenesis(), late])).toBe("ignored, dated after it was sealed");
    expect(counted([...signedGenesis(), decision("alice", { decided_at: "2026-10-31T12:06:00.000Z" })])).toEqual([]);
  });

  it("refuses changes that do not fit the reviewers as they stand", () => {
    const records = [
      ...signedGenesis(),
      keyRecord("alice", { type: "add", reviewer_id: "rev_bob", name: "Bob", public_key: people.dave.publicKey }),
      keyRecord("alice", { type: "add", reviewer_id: "rev_dave", name: "Dave", public_key: people.bob.publicKey }),
      keyRecord("alice", { type: "reenable", reviewer_id: "rev_bob" }),
      keyRecord("alice", { type: "rotate", reviewer_id: "rev_bob", public_key: people.bob.publicKey }),
    ];
    expect(replay(...records).events.slice(-4).map(e => e.text)).toEqual([
      "ignored, rev_bob is already a reviewer",
      "ignored, the key is another reviewer's",
      "ignored, rev_bob is not suspended",
      "ignored, the key is already theirs",
    ]);
  });

  it("skips packets of other connectors and anything not a review record", () => {
    const log = replay(...signedGenesis(), null, "text", { schema: "other" }, decision("alice"));
    expect(log.decisions.map(d => d.sequence)).toEqual([6]);
  });

  it("reads records in sequence order whatever order they are given", () => {
    const records = chain(...signedGenesis(), decision("alice"));
    expect(replayReviewLog([...records].reverse(), PIN).decisions).toHaveLength(1);
  });
});
