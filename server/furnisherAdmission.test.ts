import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assembleFile, type StoredLine } from "./agentFile";
import {
  ADMISSION_SCHEMA,
  admissionGate,
  checkAdmissionForm,
  signAdmission,
  type AdmissionGate,
  type AdmittedKey,
  type UnsignedAdmission,
} from "./furnisherAdmission";
import type { Furnisher } from "./furnishers";
import { releaseFor, type Line, type Review } from "./lineState";
import { canonicalizeJson, signedEventHash } from "./outcomeProof";
import { evidenceDigest, newReviewerKey } from "./reviewDecision";
import {
  REVIEWER_KEY_SCHEMA,
  genesisHash,
  replayReviewLog,
  signKeyRecord,
  type KeyChange,
  type LogRecord,
} from "./reviewLog";

const T0 = new Date("2026-11-02T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ORG = "99999999-8888-4777-8666-555555555555";
const OTHER_ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
const FURNISHER = "fur_levymerchant1";
// The furnisher's two signing keys, by key_id.
const levyKeys: Record<string, ReturnType<typeof newReviewerKey>> = { "levy-1": newReviewerKey(), "levy-2": newReviewerKey() };
const KEY = { key_id: "levy-1", public_key: levyKeys["levy-1"].publicKey };
const SECOND_KEY = { key_id: "levy-2", public_key: levyKeys["levy-2"].publicKey };
const people = { alice: newReviewerKey(), bob: newReviewerKey(), carol: newReviewerKey() };
type Person = keyof typeof people;
const TEAM = (["alice", "bob", "carol"] as const).map(p => ({
  reviewer_id: `rev_${p}`,
  name: p,
  public_key: people[p].publicKey,
}));
const PIN = genesisHash(TEAM);

const iso = (at: Date) => at.toISOString();
const admit = (reviewer: Person, overrides: Record<string, unknown> = {}, at = T0) =>
  signAdmission(
    {
      schema: ADMISSION_SCHEMA,
      reviewer_id: `rev_${reviewer}`,
      furnisher_id: FURNISHER,
      decision: "admit",
      counteraudit_org_id: ORG,
      keys: [KEY],
      arms_length: true,
      probation_days: 90,
      decided_at: iso(at),
      ...overrides,
    } as UnsignedAdmission,
    people[reviewer].privateKeyPem
  );
const revoke = (reviewer: Person, at = T0) =>
  signAdmission(
    {
      schema: ADMISSION_SCHEMA,
      reviewer_id: `rev_${reviewer}`,
      furnisher_id: FURNISHER,
      decision: "revoke",
      reason: "related to its subjects",
      decided_at: iso(at),
    },
    people[reviewer].privateKeyPem
  );
const keyRecord = (signer: Person, change: KeyChange, at = T0) =>
  signKeyRecord(
    { schema: REVIEWER_KEY_SCHEMA, signer_id: `rev_${signer}`, change, decided_at: iso(at) },
    people[signer].privateKeyPem
  );
const genesis = () => (["alice", "bob", "carol"] as const).map(p => keyRecord(p, { type: "genesis", reviewers: TEAM }));

// The records as sealed, in order; each sealed when its own record says, unless given a time.
function sealed(...items: (unknown | { record: unknown; at: Date })[]): LogRecord[] {
  return items.map((item, sequence) => {
    const timed = typeof item === "object" && item !== null && "at" in item && "record" in item;
    const record = timed ? (item as { record: unknown }).record : item;
    const decidedAt = (record as { decided_at?: string }).decided_at;
    return {
      sequence,
      packetId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      sealedAt: timed ? (item as { at: Date }).at : new Date(decidedAt ?? iso(T0)),
      record,
    };
  });
}
const replay = (records: LogRecord[], pinned: string | null = PIN, testnet: string | null = null) =>
  replayReviewLog(records, pinned, testnet);

describe("furnisher admission records", () => {
  it("takes an admission or a revocation in its strict form only", () => {
    expect(checkAdmissionForm(admit("alice")).ok).toBe(true);
    expect(checkAdmissionForm(revoke("alice")).ok).toBe(true);
    const refused: [string, Record<string, unknown>][] = [
      ["an unknown field", { ...admit("alice"), note: "x" }],
      ["a revocation that names keys", { ...revoke("alice"), keys: [KEY] }],
      ["a revocation with no reason", { ...revoke("alice"), reason: " " }],
      ["an admission with a reason", { ...admit("alice"), reason: "vetted" }],
      ["no word on arm's length", { ...admit("alice"), arms_length: false }],
      ["too short a probation", { ...admit("alice"), probation_days: 89 }],
      ["too long a probation", { ...admit("alice"), probation_days: 366 }],
      ["a fractional probation", { ...admit("alice"), probation_days: 90.5 }],
      ["keys out of order", { ...admit("alice"), keys: [SECOND_KEY, KEY] }],
      ["one key listed twice", { ...admit("alice"), keys: [KEY, { ...KEY, key_id: "levy-3" }] }],
      ["no keys", { ...admit("alice"), keys: [] }],
      ["a key in another spelling", { ...admit("alice"), keys: [{ key_id: "levy-1", public_key: "ed25519:" + "_".repeat(43) }] }],
      ["an uppercase organization", { ...admit("alice"), counteraudit_org_id: OTHER_ORG.toUpperCase() }],
      ["another decision", { ...admit("alice"), decision: "approve" }],
      ["a time without milliseconds", { ...admit("alice"), decided_at: "2026-11-02T10:00:00Z" }],
    ];
    for (const [name, value] of refused) expect(checkAdmissionForm(value).ok, name).toBe(false);
  });
});

describe("replaying admissions from the review log", () => {
  it("admits a furnisher once two reviewers admit the same organization and keys, on the longer probation", () => {
    const later = new Date(T0.getTime() + 60_000);
    const log = replay(sealed(...genesis(), admit("alice", { probation_days: 180 }), admit("bob", {}, later)));
    const state = log.admissions.get(FURNISHER)!;
    expect(state.admitted).toEqual({
      orgId: ORG,
      keys: [KEY],
      since: later,
      probationUntil: new Date(later.getTime() + 180 * DAY),
      by: ["rev_alice", "rev_bob"],
      sequence: 4,
    });
    expect(state.pending).toEqual([]);
    expect(log.events.slice(-2).map(e => e.text)).toEqual([
      `rev_alice voted to admit ${FURNISHER} (1 of 2)`,
      `${FURNISHER} admitted by rev_alice and rev_bob, on probation for 180 days`,
    ]);
  });

  it("does not admit on one reviewer, however many times they admit", () => {
    const later = new Date(T0.getTime() + 60_000);
    const once = admit("alice");
    const log = replay(sealed(...genesis(), once, once, admit("alice", {}, later)));
    const state = log.admissions.get(FURNISHER)!;
    expect(state.admitted).toBeNull();
    expect(state.pending).toEqual([{ orgId: ORG, keys: [KEY], by: ["rev_alice"] }]);
    expect(log.events.map(e => e.text)).toContain("admission ignored, sealed before");
  });

  it("never combines admissions that name different keys or organizations", () => {
    const keys = replay(sealed(...genesis(), admit("alice"), admit("bob", { keys: [KEY, SECOND_KEY] })));
    expect(keys.admissions.get(FURNISHER)!.admitted).toBeNull();
    expect(keys.admissions.get(FURNISHER)!.pending).toHaveLength(2);
    const org = replay(sealed(...genesis(), admit("alice"), admit("bob", { counteraudit_org_id: OTHER_ORG })));
    expect(org.admissions.get(FURNISHER)!.admitted).toBeNull();
  });

  it("ends an admission on one revocation, even by a suspended reviewer, and admits again with a new probation", () => {
    const t = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
    const admitted = [...genesis(), admit("alice"), admit("bob")];
    const revoked = replay(sealed(...admitted, revoke("carol", t(5))));
    expect(revoked.admissions.get(FURNISHER)).toMatchObject({
      admitted: null,
      revoked: { by: "rev_carol", reason: "related to its subjects", sequence: 5 },
    });

    // Suspended, carol's revocation still counts: a stop fails closed.
    const suspended = replay(
      sealed(...admitted, keyRecord("alice", { type: "suspend", reviewer_id: "rev_carol" }, t(1)), revoke("carol", t(5)))
    );
    expect(suspended.reviewers!.get("rev_carol")!.status).toBe("suspended");
    expect(suspended.admissions.get(FURNISHER)!.admitted).toBeNull();

    // A revocation also clears a vote waiting for its second reviewer.
    const cleared = replay(sealed(...genesis(), admit("alice"), revoke("bob", t(1)), admit("carol", {}, t(2))));
    expect(cleared.admissions.get(FURNISHER)!.admitted).toBeNull();

    const again = replay(sealed(...admitted, revoke("carol", t(5)), admit("alice", {}, t(10)), admit("carol", {}, t(11))));
    const state = again.admissions.get(FURNISHER)!;
    expect(state.revoked).toBeNull();
    expect(state.admitted).toMatchObject({ by: ["rev_alice", "rev_carol"], since: t(11) });
    expect(state.admitted!.probationUntil).toEqual(new Date(t(11).getTime() + 90 * DAY));
  });

  it("counts no admission by a suspended or removed reviewer, or signed with a key since rotated", () => {
    const t = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
    const suspend = keyRecord("carol", { type: "suspend", reviewer_id: "rev_bob" }, t(1));
    const suspended = replay(sealed(...genesis(), suspend, admit("alice", {}, t(2)), admit("bob", {}, t(3))));
    expect(suspended.admissions.get(FURNISHER)!.admitted).toBeNull();
    expect(suspended.events.map(e => e.text)).toContain(`admission of ${FURNISHER} ignored, rev_bob was suspended when it was sealed`);

    // Sealed while suspended, it stays uncounted after the reviewer is re-enabled.
    const reenable: KeyChange = { type: "reenable", reviewer_id: "rev_bob" };
    const reenabled = replay(
      sealed(...genesis(), suspend, admit("alice", {}, t(2)), admit("bob", {}, t(3)), keyRecord("alice", reenable, t(4)), keyRecord("carol", reenable, t(5)))
    );
    expect(reenabled.reviewers!.get("rev_bob")!.status).toBe("active");
    expect(reenabled.admissions.get(FURNISHER)!.admitted).toBeNull();

    // Suspended after the admission took effect: it no longer stands, as their decisions do not.
    const suspendedLater = replay(sealed(...genesis(), admit("alice"), admit("bob"), suspend));
    expect(suspendedLater.admissions.get(FURNISHER)!.admitted).toBeNull();

    const remove: KeyChange = { type: "remove", reviewer_id: "rev_bob" };
    const removed = replay(sealed(...genesis(), admit("alice"), admit("bob"), keyRecord("alice", remove, t(1)), keyRecord("carol", remove, t(2))));
    expect(removed.admissions.get(FURNISHER)!.admitted).toBeNull();

    const rotate: KeyChange = { type: "rotate", reviewer_id: "rev_bob", public_key: newReviewerKey().publicKey };
    const rotated = replay(sealed(...genesis(), admit("alice"), admit("bob"), keyRecord("alice", rotate, t(1)), keyRecord("carol", rotate, t(2))));
    expect(rotated.admissions.get(FURNISHER)!.admitted).toBeNull();
    expect(rotated.events.map(e => e.text)).toContain("admission ignored, rev_bob has since been removed or given a new key");
  });

  it("keeps a revocation in force whatever happens to its reviewer afterwards", () => {
    const t = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
    const revoked = [...genesis(), admit("alice"), admit("bob"), revoke("carol", t(1))];
    const rotate: KeyChange = { type: "rotate", reviewer_id: "rev_carol", public_key: newReviewerKey().publicKey };
    const rotated = replay(sealed(...revoked, keyRecord("alice", rotate, t(2)), keyRecord("bob", rotate, t(3))));
    expect(rotated.reviewers!.get("rev_carol")!.publicKey).not.toBe(people.carol.publicKey);
    expect(rotated.admissions.get(FURNISHER)).toMatchObject({ admitted: null, revoked: { by: "rev_carol" } });

    const remove: KeyChange = { type: "remove", reviewer_id: "rev_carol" };
    const removed = replay(sealed(...revoked, keyRecord("alice", remove, t(2)), keyRecord("bob", remove, t(3))));
    expect(removed.reviewers!.get("rev_carol")!.status).toBe("removed");
    expect(removed.admissions.get(FURNISHER)).toMatchObject({ admitted: null, revoked: { by: "rev_carol" } });

    // A revocation sealed after its reviewer was removed counts for nothing.
    const late = replay(sealed(...genesis(), admit("alice"), admit("bob"), keyRecord("alice", remove, t(1)), keyRecord("bob", remove, t(2)), revoke("carol", t(3))));
    expect(late.admissions.get(FURNISHER)!.admitted).not.toBeNull();
    expect(late.events.at(-1)!.text).toBe("revocation ignored, not signed by a reviewer with the key they held when it was sealed");
  });

  it("counts no admission sealed before its reviewer was one", () => {
    const t = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
    const dave = newReviewerKey();
    const add: KeyChange = { type: "add", reviewer_id: "rev_dave", name: "dave", public_key: dave.publicKey };
    const early = signAdmission(
      {
        schema: ADMISSION_SCHEMA,
        reviewer_id: "rev_dave",
        furnisher_id: FURNISHER,
        decision: "admit",
        counteraudit_org_id: ORG,
        keys: [KEY],
        arms_length: true,
        probation_days: 90,
        decided_at: iso(T0),
      },
      dave.privateKeyPem
    );
    const log = replay(sealed(...genesis(), early, admit("alice"), keyRecord("alice", add, t(1)), keyRecord("bob", add, t(2))));
    expect(log.reviewers!.get("rev_dave")!.status).toBe("active");
    expect(log.admissions.get(FURNISHER)!.admitted).toBeNull();
  });

  it("takes a reviewer's newer admission in place of their pending one for other keys", () => {
    const t = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
    // Alice admits with the wrong key, then the right one; Bob admits with the wrong one.
    const log = replay(
      sealed(...genesis(), admit("alice", { keys: [SECOND_KEY] }), admit("alice", {}, t(1)), admit("bob", { keys: [SECOND_KEY] }, t(2)))
    );
    const state = log.admissions.get(FURNISHER)!;
    expect(state.admitted).toBeNull();
    expect(state.pending).toEqual([
      { orgId: ORG, keys: [KEY], by: ["rev_alice"] },
      { orgId: ORG, keys: [SECOND_KEY], by: ["rev_bob"] },
    ]);
  });

  it("ignores an admission dated after it was sealed, or sealed more than a day after it was signed", () => {
    const early = new Date(T0.getTime() - 6 * 60_000);
    const late = new Date(T0.getTime() + DAY + 60_000);
    const log = replay(sealed(...genesis(), { record: admit("alice"), at: early }, { record: admit("bob"), at: late }));
    expect(log.admissions.get(FURNISHER)?.admitted ?? null).toBeNull();
    expect(log.events.map(e => e.text)).toEqual(
      expect.arrayContaining([
        "admission ignored, dated after it was sealed",
        "admission ignored, sealed more than a day after it was signed",
      ])
    );
    // Within bounds: sealed four minutes before its own date, and a day after it.
    const fine = replay(
      sealed(...genesis(), { record: admit("alice"), at: new Date(T0.getTime() - 4 * 60_000) }, { record: admit("bob"), at: new Date(T0.getTime() + DAY) })
    );
    expect(fine.admissions.get(FURNISHER)!.admitted).not.toBeNull();
  });

  it("counts no admission without a genesis, or under the testnet genesis", () => {
    const records = sealed(...genesis(), admit("alice"), admit("bob"));
    expect(replay(records, null).admissions.size).toBe(0);
    const testnet = replay(records, PIN, PIN);
    expect(testnet.admissions.size).toBe(0);
    expect(testnet.events.at(-1)!.text).toBe("admission ignored, admissions do not count under the testnet genesis");
  });

  it("leaves the reviewer set as it was", () => {
    const without = replay(sealed(...genesis()));
    const withAdmissions = replay(sealed(...genesis(), admit("alice"), revoke("bob")));
    expect(withAdmissions.reviewers).toEqual(without.reviewers);
  });
});

// An outcome event signed as the furnisher tool signs it.
function signEvent(unsigned: Record<string, unknown>, privateKeyPem: string) {
  const payload = Buffer.from(`agent-bureau/outcome-event/v1\n${canonicalizeJson(unsigned)}`, "utf8");
  return { ...unsigned, signature: `ed25519:${sign(null, payload, createPrivateKey(privateKeyPem)).toString("base64url")}` };
}
const unsignedEvent = (keyId: string, overrides: Record<string, unknown> = {}) => ({
  schema_version: "1",
  furnisher_id: FURNISHER,
  key_id: keyId,
  event_id: "charge-1",
  subject_ref: { wallet: "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77" },
  occurred_at: "2026-11-03T10:00:00.000Z",
  outcome: "delivered",
  ...overrides,
});

// A live line, as stored: its event signed with the key its receipt names, in that organization.
function liveLine(overrides: Partial<Line> = {}, receiptSigner: AdmittedKey = KEY, orgId = ORG): Line {
  const event = signEvent(unsignedEvent(receiptSigner.key_id), levyKeys[receiptSigner.key_id].privateKeyPem);
  return {
    id: 1,
    furnisherId: FURNISHER,
    eventId: "charge-1",
    subjectRef: { wallet: "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77" },
    dataClass: "live",
    proofOk: true,
    evidenceStatus: "verified",
    evidenceResult: { status: "verified", reasons: [] },
    evidenceKey: null,
    signedEventHash: signedEventHash(event),
    displayState: "unverified",
    relationType: null,
    relationTargetEventId: null,
    caCreatedAt: new Date(T0.getTime() + 200 * DAY),
    signedEvent: event,
    receipt: { org_id: orgId, outcome_claim: { signer: { key_id: receiptSigner.key_id, public_key: receiptSigner.public_key } } },
    ...overrides,
  };
}
const approvals = (line: Line, decision: Review["decision"] = "approve"): Review[] =>
  ["rev_alice", "rev_bob"].map((reviewerId, i) => ({
    id: i + 1,
    reviewerId,
    decision,
    signedEventHash: line.signedEventHash,
    dataClass: line.dataClass,
    evidenceDigest: evidenceDigest(line.evidenceResult),
    decidedAt: T0,
  }));

describe("releasing a live line", () => {
  const admitted = replay(sealed(...genesis(), admit("alice"), admit("bob"))).admissions;
  const gate = (line: Line, furnishers: Record<string, Furnisher> = {}) => admissionGate(line, admitted, furnishers);

  it("holds it until two reviewers admit its furnisher, and releases it after", () => {
    const line = liveLine();
    const none = admissionGate(line, new Map(), {});
    expect(releaseFor(line, approvals(line), none)).toEqual({
      released: null,
      holdingBack: "its furnisher is not admitted by two reviewers (pnpm review admissions)",
    });
    expect(releaseFor(line, approvals(line))).toEqual({
      released: null,
      holdingBack: "its furnisher's admission was not read",
    });
    expect(gate(line)).toEqual({ admitted: true, onProbation: false, probationUntil: new Date(T0.getTime() + 90 * DAY) });
    expect(releaseFor(line, approvals(line), gate(line)).released).toBe("two_person");
  });

  it("holds a line from another organization or a key the admission does not name", () => {
    const elsewhere = liveLine({}, KEY, OTHER_ORG);
    expect(releaseFor(elsewhere, approvals(elsewhere), gate(elsewhere)).holdingBack).toBe(
      `it was sealed in ${OTHER_ORG}, not the organization its furnisher was admitted for`
    );
    const otherKey = liveLine({}, SECOND_KEY);
    expect(releaseFor(otherKey, approvals(otherKey), gate(otherKey)).holdingBack).toBe(
      "its key levy-2 is not one its furnisher was admitted with"
    );
    const unread = liveLine({ receipt: null });
    expect(releaseFor(unread, approvals(unread), gate(unread)).holdingBack).toBe(
      "its receipt does not say which organization and key it came from"
    );
    // Listed in server/furnishers.ts with the key revoked there.
    const revokedThere: Record<string, Furnisher> = {
      [FURNISHER]: { counterauditOrgId: ORG, keys: { [KEY.key_id]: { publicKey: KEY.public_key, status: "revoked" } } },
    };
    const line = liveLine();
    expect(releaseFor(line, approvals(line), gate(line, revokedThere)).holdingBack).toBe(
      "its key levy-1 is not active in server/furnishers.ts"
    );
  });

  it("holds a line whose signed event the key its receipt names did not sign", () => {
    const held = (line: Line) => releaseFor(line, approvals(line), gate(line)).holdingBack;
    // A receipt edited to name the admitted key, over an event another key signed.
    const forged = signEvent(unsignedEvent(KEY.key_id), levyKeys[SECOND_KEY.key_id].privateKeyPem);
    expect(held(liveLine({ signedEvent: forged, signedEventHash: signedEventHash(forged) }))).toBe(
      "its signed event does not verify with levy-1, the key its receipt names"
    );
    // An event changed after signing, with its hash changed to match.
    const line = liveLine();
    const changed = { ...(line.signedEvent as Record<string, unknown>), outcome: "paid" };
    expect(held(liveLine({ signedEvent: changed, signedEventHash: signedEventHash(changed) }))).toBe(
      "its signed event does not verify with levy-1, the key its receipt names"
    );
    // Another event the admitted key signed, in place of the one reviewers approved.
    const other = signEvent(unsignedEvent(KEY.key_id, { event_id: "charge-2" }), levyKeys[KEY.key_id].privateKeyPem);
    const swapped = { ...line, signedEvent: other };
    expect(releaseFor(swapped, approvals(line), gate(swapped)).holdingBack).toBe(
      "its signed event does not hash to the signedEventHash reviewers sign"
    );
    // An event the admitted key signed for another furnisher.
    const elsewhere = signEvent(unsignedEvent(KEY.key_id, { furnisher_id: "fur_othermerchant" }), levyKeys[KEY.key_id].privateKeyPem);
    expect(held(liveLine({ signedEvent: elsewhere, signedEventHash: signedEventHash(elsewhere) }))).toBe(
      "its signed event names another furnisher"
    );
    // A receipt whose key does not parse fails the same way, without throwing.
    const badKey = liveLine({}, { key_id: KEY.key_id, public_key: "ed25519:short" });
    expect(gate(badKey)).toEqual({ admitted: false, problem: "its signed event does not verify with levy-1, the key its receipt names" });
  });

  it("holds a line whose stored event is nested too deep to hash, without throwing", () => {
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) nested = { a: nested };
    const deep = liveLine({ signedEvent: { ...(liveLine().signedEvent as Record<string, unknown>), nested } });
    expect(gate(deep)).toEqual({ admitted: false, problem: "its signed event does not hash to the signedEventHash reviewers sign" });
    expect(admissionGate(deep, new Map(), {})).toEqual({
      admitted: false,
      problem: "its furnisher is not admitted by two reviewers (pnpm review admissions)",
    });
  });

  it("reads the signed event and receipt when the database returns JSON as text", () => {
    const line = liveLine();
    const asText = { ...line, signedEvent: JSON.stringify(line.signedEvent), receipt: JSON.stringify(line.receipt) };
    expect(releaseFor(asText, approvals(line), gate(asText)).released).toBe("two_person");
  });

  it("says so when the admission was revoked", () => {
    const revoked = replay(sealed(...genesis(), admit("alice"), admit("bob"), revoke("carol"))).admissions;
    const line = liveLine();
    expect(releaseFor(line, approvals(line), admissionGate(line, revoked, {})).holdingBack).toBe(
      "its furnisher's admission was revoked by rev_carol at sequence 5"
    );
  });

  it("takes no waiver for a line sealed during probation, and takes one after", () => {
    const evidence = { status: "needs_review", reasons: ["no machine check exists for delivered outcomes"] };
    const during = liveLine({ evidenceStatus: "needs_review", evidenceResult: evidence, caCreatedAt: new Date(T0.getTime() + 10 * DAY) });
    const until = new Date(T0.getTime() + 90 * DAY);
    expect(gate(during)).toEqual({ admitted: true, onProbation: true, probationUntil: until });
    expect(releaseFor(during, approvals(during, "approve_with_waiver"), gate(during)).holdingBack).toBe(
      `its furnisher is on probation until ${until.toISOString()}, when no approval can waive the evidence for its lines`
    );
    // Evidence that passed needs no waiver, probation or not.
    const plain = liveLine({ caCreatedAt: new Date(T0.getTime() + 10 * DAY) });
    expect(releaseFor(plain, approvals(plain), gate(plain)).released).toBe("two_person");
    // A line with no sealing time is taken as sealed during probation.
    const undated = liveLine({ evidenceStatus: "needs_review", evidenceResult: evidence, caCreatedAt: undefined });
    expect(gate(undated)).toMatchObject({ onProbation: true });

    // Editing the evidenceStatus column to verified does not make a waiver plain.
    const edited = { ...during, evidenceStatus: "verified" };
    expect(releaseFor(edited, approvals(edited, "approve_with_waiver"), gate(edited)).holdingBack).toBe(
      "its evidenceStatus does not match the evidence result reviewers sign; run the intake again"
    );

    const after = liveLine({ evidenceStatus: "needs_review", evidenceResult: evidence, caCreatedAt: until });
    expect(releaseFor(after, approvals(after, "approve_with_waiver"), gate(after)).released).toBe("two_person");
  });

  it("asks nothing of test data", () => {
    const test = liveLine({ dataClass: "test", receipt: null });
    expect(admissionGate(test, new Map(), {})).toEqual({ admitted: true, onProbation: false, probationUntil: null });
    expect(releaseFor(test, approvals(test).slice(0, 1)).released).toBe("solo_test");
  });
});

describe("a file with a line sealed during probation", () => {
  it("marks the line and says what that means", () => {
    const base = liveLine({ caCreatedAt: new Date(T0.getTime() + DAY) });
    const event = base.signedEvent as ReturnType<typeof unsignedEvent> & { signature: string };
    const line: StoredLine = {
      ...base,
      outcome: "delivered",
      occurredAt: new Date(event.occurred_at),
      receivedAt: new Date(T0.getTime() + DAY),
      caCreatedAt: new Date(T0.getTime() + DAY),
      packetId: "00000000-0000-4000-8000-000000000001",
      entryHash: "e".repeat(64),
      sequence: 1,
      signedEvent: event,
    };
    const admitted = replay(sealed(...genesis(), admit("alice"), admit("bob"))).admissions;
    const admissionOf = (l: Line): AdmissionGate => admissionGate(l, admitted, {});
    const options = { now: new Date(T0.getTime() + 2 * DAY), bureauOrgId: ORG, testnetReviewers: false, furnishers: {} };
    const { file } = assembleFile(event.subject_ref, [line], l => approvals(l), { ...options, admissionOf });
    expect(file.furnished_outcomes).toHaveLength(1);
    expect(file.furnished_outcomes[0].furnisher_on_probation).toBe(true);
    expect(file.disclosures.some(d => d.includes("furnisher_on_probation"))).toBe(true);

    // Without the admission read, no live line is on the file.
    expect(assembleFile(event.subject_ref, [line], l => approvals(l), options).file.furnished_outcomes).toEqual([]);
  });
});
