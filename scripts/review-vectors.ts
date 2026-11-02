// The review log's shared test vectors (docs/review-log-design.md, build step 2):
// server/fixtures/review-vectors/review-log-v1.json. CounterAudit replays the review
// organization's chain with its own port of the rules in server/reviewLog.ts, and checks
// reviewers' key approvals (server/keyApproval.ts) and the form of furnisher admissions
// (server/furnisherAdmission.ts); it copies this file, pinned by SHA-256, and runs the same cases. Each case's expected result is written here by hand, and
// server/reviewVectors.test.ts checks both this code's answers and that the file is what this
// script builds. Rebuild with: pnpm review:vectors
//
// The keys are test keys derived from fixed seeds, never used for anything else. Ed25519
// signatures are deterministic, so the file is the same on every run.
import { createHash, createPrivateKey } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ADMISSION_SCHEMA,
  signAdmission,
  type UnsignedAdmission,
} from "../server/furnisherAdmission";
import {
  KEY_APPROVAL_SCHEMA,
  payloadDigest,
  signKeyApproval,
  type KeyApproval,
} from "../server/keyApproval";
import {
  REVIEW_SCHEMA,
  reviewerPublicKey,
  signReviewDecision,
} from "../server/reviewDecision";
import {
  REVIEWER_KEY_SCHEMA,
  genesisHash,
  signKeyRecord,
  type KeyChange,
  type ReviewerEntry,
  type ReviewerStatus,
} from "../server/reviewLog";

export const VECTORS_PATH = path.join(
  "server",
  "fixtures",
  "review-vectors",
  "review-log-v1.json"
);

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SEALED = "2026-11-01T12:00:00.000Z";
const DECIDED = "2026-11-01T11:00:00.000Z";
const ORG = "00000000-0000-4000-8000-0000000000a1";
const SMALL_ORDER_KEY = `ed25519:${Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]).toString("base64url")}`;
const REQUEST = "5b0c1f2e-8a4d-4c3b-9e1f-0a2b3c4d5e6f";
const FURNISHER_ORG = "00000000-0000-4000-8000-0000000000b2";

type TestKey = { seed: string; privateKeyPem: string; public_key: string };

function testKey(name: string): TestKey {
  const seed = createHash("sha256").update(`agent-bureau review vectors ${name}`).digest();
  const privateKeyPem = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: "der",
    type: "pkcs8",
  })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  return { seed: seed.toString("hex"), privateKeyPem, public_key: reviewerPublicKey(privateKeyPem) };
}

const NAMES = [
  "alice",
  "bob",
  "carol",
  "dave",
  "bob_k1",
  "bob_k2",
  "impostor_alice",
  "impostor_bob",
  "impostor_carol",
] as const;
type KeyName = (typeof NAMES)[number];

export type ExpectedReviewer = { name: string; public_key: string; status: ReviewerStatus };

export type ReviewVectors = {
  description: string;
  keys: Record<KeyName, { seed: string; public_key: string }>;
  review_log: {
    id: string;
    pinned_genesis: string | null;
    records: { sequence: number; sealed_at: string; record: unknown }[];
    expect: { reviewers: Record<string, ExpectedReviewer> | null };
  }[];
  key_approvals: {
    id: string;
    approval: unknown;
    payload: Record<string, unknown>;
    verify_with: KeyName;
    expect: {
      form: "valid" | "invalid";
      signature: "valid" | "invalid" | null;
      payload_sha256: string;
      payload_matches: boolean;
    };
  }[];
  admission_forms: { id: string; record: unknown; expect: "valid" | "invalid" }[];
};

export function buildReviewVectors(): ReviewVectors {
  const keys = Object.fromEntries(NAMES.map(n => [n, testKey(n)])) as Record<KeyName, TestKey>;
  const pub = (n: KeyName) => keys[n].public_key;

  const TEAM: ReviewerEntry[] = (["alice", "bob", "carol"] as const).map(p => ({
    reviewer_id: `rev_${p}`,
    name: p[0].toUpperCase() + p.slice(1),
    public_key: pub(p),
  }));
  const PIN = genesisHash(TEAM);
  const genesis: KeyChange = { type: "genesis", reviewers: TEAM };

  const keyRecord = (
    signer: "alice" | "bob" | "carol" | "dave",
    change: KeyChange,
    options: { key?: KeyName; decidedAt?: string; reason?: string } = {}
  ) =>
    signKeyRecord(
      {
        schema: REVIEWER_KEY_SCHEMA,
        signer_id: `rev_${signer}`,
        change,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
        decided_at: options.decidedAt ?? DECIDED,
      },
      keys[options.key ?? signer].privateKeyPem
    );
  const signedGenesis = () => (["alice", "bob", "carol"] as const).map(p => keyRecord(p, genesis));
  const decision = (reviewer: "alice" | "bob" | "carol") =>
    signReviewDecision(
      {
        schema: REVIEW_SCHEMA,
        reviewer_id: `rev_${reviewer}`,
        furnisher_id: "fur_vectors01",
        event_id: "vectors-event-1",
        signed_event_hash: "ab".repeat(32),
        data_class: "test",
        evidence_digest: "cd".repeat(32),
        decision: "approve",
        decided_at: DECIDED,
      },
      keys[reviewer].privateKeyPem
    );

  const admission = (reviewer: "alice" | "bob" | "carol", overrides: Record<string, unknown> = {}) =>
    signAdmission(
      {
        schema: ADMISSION_SCHEMA,
        reviewer_id: `rev_${reviewer}`,
        furnisher_id: "fur_vectors01",
        decision: "admit",
        counteraudit_org_id: FURNISHER_ORG,
        keys: [{ key_id: "vectors-1", public_key: pub("dave") }],
        arms_length: true,
        probation_days: 90,
        decided_at: DECIDED,
        ...overrides,
      } as UnsignedAdmission,
      keys[reviewer].privateKeyPem
    );
  const revocation = (reviewer: "alice" | "bob" | "carol", reason = "related to its subjects") =>
    signAdmission(
      {
        schema: ADMISSION_SCHEMA,
        reviewer_id: `rev_${reviewer}`,
        furnisher_id: "fur_vectors01",
        decision: "revoke",
        reason,
        decided_at: DECIDED,
      },
      keys[reviewer].privateKeyPem
    );

  const chain = (...records: unknown[]) =>
    records.map((record, sequence) => ({ sequence, sealed_at: SEALED, record }));
  const reviewers = (
    statuses: Partial<Record<"alice" | "bob" | "carol" | "dave", ReviewerStatus>>,
    publicKeys: Partial<Record<"alice" | "bob" | "carol" | "dave", string>> = {}
  ) =>
    Object.fromEntries(
      (Object.keys(statuses) as ("alice" | "bob" | "carol" | "dave")[]).map(p => [
        `rev_${p}`,
        {
          name: p[0].toUpperCase() + p.slice(1),
          public_key: publicKeys[p] ?? pub(p),
          status: statuses[p]!,
        },
      ])
    );
  const all = (status: ReviewerStatus = "active") => reviewers({ alice: status, bob: status, carol: status });

  const fresh = { type: "add", reviewer_id: "rev_dave", name: "Dave", public_key: pub("dave") } as KeyChange;
  const toK1 = { type: "rotate", reviewer_id: "rev_bob", public_key: pub("bob_k1") } as KeyChange;
  const toK2 = { type: "rotate", reviewer_id: "rev_bob", public_key: pub("bob_k2") } as KeyChange;
  const reenableBob = { type: "reenable", reviewer_id: "rev_bob" } as KeyChange;
  const impostors = TEAM.map((r, i) => ({
    ...r,
    public_key: pub((["impostor_alice", "impostor_bob", "impostor_carol"] as const)[i]),
  }));
  const k1Votes = [keyRecord("alice", toK1), keyRecord("carol", toK1)];

  const review_log: ReviewVectors["review_log"] = [
    { id: "genesis_complete", pinned_genesis: PIN, records: chain(...signedGenesis()), expect: { reviewers: all() } },
    {
      id: "genesis_missing_a_signature",
      pinned_genesis: PIN,
      records: chain(...signedGenesis().slice(0, 2)),
      expect: { reviewers: null },
    },
    { id: "genesis_not_pinned", pinned_genesis: null, records: chain(...signedGenesis()), expect: { reviewers: null } },
    {
      id: "genesis_signed_with_another_key",
      pinned_genesis: PIN,
      records: chain(...signedGenesis().slice(0, 2), keyRecord("carol", genesis, { key: "dave" })),
      expect: { reviewers: null },
    },
    {
      id: "impostor_genesis_sealed_first",
      pinned_genesis: PIN,
      records: chain(
        keyRecord("alice", { type: "genesis", reviewers: impostors }, { key: "impostor_alice" }),
        keyRecord("bob", { type: "genesis", reviewers: impostors }, { key: "impostor_bob" }),
        keyRecord("carol", { type: "genesis", reviewers: impostors }, { key: "impostor_carol" }),
        ...signedGenesis()
      ),
      expect: { reviewers: all() },
    },
    {
      id: "second_genesis_ignored",
      pinned_genesis: PIN,
      records: chain(...signedGenesis(), ...signedGenesis()),
      expect: { reviewers: all() },
    },
    {
      id: "one_reviewer_suspends",
      pinned_genesis: PIN,
      records: chain(...signedGenesis(), keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" })),
      expect: { reviewers: reviewers({ alice: "active", bob: "suspended", carol: "active" }) },
    },
    {
      id: "two_reviewers_add",
      pinned_genesis: PIN,
      records: chain(...signedGenesis(), keyRecord("alice", fresh), keyRecord("bob", fresh)),
      expect: { reviewers: reviewers({ alice: "active", bob: "active", carol: "active", dave: "active" }) },
    },
    {
      id: "one_reviewer_twice_adds_nothing",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("alice", fresh),
        keyRecord("alice", fresh, { decidedAt: "2026-11-01T11:01:00.000Z" })
      ),
      expect: { reviewers: all() },
    },
    {
      id: "a_change_clears_pending_votes",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("carol", { type: "suspend", reviewer_id: "rev_bob" }),
        keyRecord("alice", reenableBob),
        keyRecord("alice", toK1),
        keyRecord("carol", toK1),
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }),
        keyRecord("carol", reenableBob)
      ),
      expect: {
        reviewers: reviewers({ alice: "active", bob: "suspended", carol: "active" }, { bob: pub("bob_k1") }),
      },
    },
    {
      id: "a_record_sealed_again_counts_for_nothing",
      pinned_genesis: PIN,
      records: chain(...signedGenesis(), ...k1Votes, keyRecord("alice", toK2), keyRecord("carol", toK2), ...k1Votes),
      expect: { reviewers: reviewers({ alice: "active", bob: "active", carol: "active" }, { bob: pub("bob_k2") }) },
    },
    {
      id: "sealed_more_than_a_day_after_signing",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }, { decidedAt: "2026-10-31T11:59:00.000Z" })
      ),
      expect: { reviewers: all() },
    },
    {
      id: "dated_after_sealing",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }, { decidedAt: "2026-11-01T12:06:00.000Z" })
      ),
      expect: { reviewers: all() },
    },
    {
      id: "suspended_reviewers_keep_their_vote",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }),
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_carol" }),
        keyRecord("bob", { type: "remove", reviewer_id: "rev_alice" }),
        keyRecord("carol", { type: "remove", reviewer_id: "rev_alice" }),
        keyRecord("bob", reenableBob),
        keyRecord("carol", reenableBob),
        keyRecord("bob", { type: "reenable", reviewer_id: "rev_carol" }),
        keyRecord("carol", { type: "reenable", reviewer_id: "rev_carol" }),
        // A removed reviewer has no vote left.
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" })
      ),
      expect: { reviewers: reviewers({ alice: "removed", bob: "active", carol: "active" }) },
    },
    {
      id: "a_rotation_settles_a_suspension",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }),
        ...k1Votes
      ),
      expect: { reviewers: reviewers({ alice: "active", bob: "active", carol: "active" }, { bob: pub("bob_k1") }) },
    },
    {
      id: "changes_that_do_not_fit",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("alice", { type: "add", reviewer_id: "rev_bob", name: "Bob", public_key: pub("dave") }),
        keyRecord("bob", { type: "add", reviewer_id: "rev_bob", name: "Bob", public_key: pub("dave") }),
        keyRecord("alice", { type: "add", reviewer_id: "rev_dave", name: "Dave", public_key: pub("bob") }),
        keyRecord("bob", { type: "add", reviewer_id: "rev_dave", name: "Dave", public_key: pub("bob") }),
        keyRecord("alice", reenableBob),
        keyRecord("carol", reenableBob),
        keyRecord("alice", { type: "rotate", reviewer_id: "rev_bob", public_key: pub("bob") }),
        keyRecord("carol", { type: "rotate", reviewer_id: "rev_bob", public_key: pub("bob") })
      ),
      expect: { reviewers: all() },
    },
    {
      id: "a_key_in_a_second_spelling_is_refused",
      pinned_genesis: genesisHash([TEAM[0], { ...TEAM[1], public_key: `${TEAM[0].public_key} ` }, TEAM[2]]),
      records: chain(
        ...(["alice", "bob", "carol"] as const).map(p =>
          keyRecord(p, {
            type: "genesis",
            reviewers: [TEAM[0], { ...TEAM[1], public_key: `${TEAM[0].public_key} ` }, TEAM[2]],
          })
        )
      ),
      expect: { reviewers: null },
    },
    {
      id: "decisions_and_other_packets_do_not_change_reviewers",
      pinned_genesis: PIN,
      records: chain(
        decision("alice"),
        ...signedGenesis(),
        null,
        { schema: "other" },
        decision("bob"),
        { ...decision("carol"), schema: REVIEWER_KEY_SCHEMA }
      ),
      expect: { reviewers: all() },
    },
    {
      // The identity point: a key under which anyone could forge a signature.
      id: "a_small_order_key_is_refused",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        ...(["alice", "bob"] as const).map(p => keyRecord(p, { ...fresh, public_key: SMALL_ORDER_KEY } as KeyChange))
      ),
      expect: { reviewers: all() },
    },
    {
      id: "a_reason_over_500_characters_is_refused",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" }, { reason: "x".repeat(501) }),
        keyRecord("carol", { type: "suspend", reviewer_id: "rev_alice" }, { reason: "y".repeat(500) })
      ),
      expect: { reviewers: reviewers({ alice: "suspended", bob: "active", carol: "active" }) },
    },
    {
      id: "a_removed_reviewers_key_stays_taken",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        ...(["alice", "bob"] as const).map(p => keyRecord(p, { type: "remove", reviewer_id: "rev_carol" })),
        ...(["alice", "bob"] as const).map(p =>
          keyRecord(p, { type: "rotate", reviewer_id: "rev_bob", public_key: pub("carol") })
        )
      ),
      expect: { reviewers: reviewers({ alice: "active", bob: "active", carol: "removed" }) },
    },
    {
      id: "furnisher_admissions_do_not_change_reviewers",
      pinned_genesis: PIN,
      records: chain(...signedGenesis(), admission("alice"), admission("bob"), revocation("carol")),
      expect: { reviewers: all() },
    },
    {
      id: "an_own_proto_key_is_refused",
      pinned_genesis: PIN,
      records: chain(
        ...signedGenesis(),
        // An own "__proto__" key, as JSON.parse makes one, beside a signed suspension.
        JSON.parse(
          `{"__proto__": {"x": 1}, ${JSON.stringify(keyRecord("alice", { type: "suspend", reviewer_id: "rev_bob" })).slice(1)}`
        )
      ),
      expect: { reviewers: all() },
    },
  ];

  const createPayload = { label: "rev_dave ingest", expires_in_days: 90, role: "ingest" };
  const approve = (
    reviewer: "alice" | "bob" | "carol",
    operation: string,
    payload: Record<string, unknown>,
    key: KeyName = reviewer
  ): KeyApproval =>
    signKeyApproval(
      {
        schema: KEY_APPROVAL_SCHEMA,
        reviewer_id: `rev_${reviewer}`,
        org_id: ORG,
        request_id: REQUEST,
        operation: operation as KeyApproval["operation"],
        payload_sha256: payloadDigest(payload),
        decided_at: DECIDED,
      },
      keys[key].privateKeyPem
    );
  const valid = approve("alice", "create_key", createPayload);
  const lastChar = valid.signature.slice(-1);
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  // The same 64 bytes with the unused low bits of the last character set: a second spelling.
  const secondSpelling = `${valid.signature.slice(0, -1)}${ALPHABET[ALPHABET.indexOf(lastChar) + 1]}`;
  const unicodePayload = { label: "Revisión ü ✓", expires_in_days: 30, role: "read" };
  const reviewOrgPayload = { genesis_hash: PIN };

  const approval = (
    id: string,
    value: unknown,
    payload: Record<string, unknown>,
    verify_with: KeyName,
    expect: Omit<ReviewVectors["key_approvals"][number]["expect"], "payload_sha256">
  ) => ({ id, approval: value, payload, verify_with, expect: { ...expect, payload_sha256: payloadDigest(payload) } });

  const key_approvals: ReviewVectors["key_approvals"] = [
    approval("create_key_approved", valid, createPayload, "alice", { form: "valid", signature: "valid", payload_matches: true }),
    approval(
      "payload_in_another_key_order",
      valid,
      { role: "ingest", label: "rev_dave ingest", expires_in_days: 90 },
      "alice",
      { form: "valid", signature: "valid", payload_matches: true }
    ),
    approval("payload_changed", valid, { ...createPayload, role: "admin" }, "alice", {
      form: "valid",
      signature: "valid",
      payload_matches: false,
    }),
    approval("signed_with_another_reviewers_key", approve("alice", "create_key", createPayload, "bob"), createPayload, "alice", {
      form: "valid",
      signature: "invalid",
      payload_matches: true,
    }),
    approval("request_id_changed_after_signing", { ...valid, request_id: "5b0c1f2e-8a4d-4c3b-9e1f-0a2b3c4d5e70" }, createPayload, "alice", {
      form: "valid",
      signature: "invalid",
      payload_matches: true,
    }),
    approval("signature_in_a_second_spelling", { ...valid, signature: secondSpelling }, createPayload, "alice", {
      form: "invalid",
      signature: null,
      payload_matches: true,
    }),
    approval("operation_not_approvable", approve("alice", "erase_packet", createPayload), createPayload, "alice", {
      form: "invalid",
      signature: null,
      payload_matches: true,
    }),
    approval("extra_field", { ...valid, note: "x" }, createPayload, "alice", { form: "invalid", signature: null, payload_matches: true }),
    approval("revoke_key_approved", approve("carol", "revoke_key", { key_id: "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d" }), {
      key_id: "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
    }, "carol", { form: "valid", signature: "valid", payload_matches: true }),
    approval("set_review_org_approved", approve("bob", "set_review_org", reviewOrgPayload), reviewOrgPayload, "bob", {
      form: "valid",
      signature: "valid",
      payload_matches: true,
    }),
    approval("payload_with_non_ascii_text", approve("alice", "create_key", unicodePayload), unicodePayload, "alice", {
      form: "valid",
      signature: "valid",
      payload_matches: true,
    }),
  ];

  return {
    description:
      "Shared test vectors for the Agent Bureau's review log (docs/review-log-design.md): review_log cases give a pinned genesis and the review organization's records in sequence order, and the reviewers they establish (null when no genesis takes effect); key_approvals cases give a reviewer's approval of a CounterAudit approval request; admission_forms give furnisher admission records and whether their form is valid. Built by scripts/review-vectors.ts in the-agent-bureau. The keys are test keys from fixed seeds.",
    keys: Object.fromEntries(NAMES.map(n => [n, { seed: keys[n].seed, public_key: keys[n].public_key }])) as ReviewVectors["keys"],
    review_log,
    key_approvals,
    admission_forms: admissionForms(admission, revocation, pub),
  };
}

// The form of a furnisher admission (agent-bureau/furnisher-admission/v1), which CounterAudit's
// review connector checks before sealing one. Signatures are the review log's to check.
function admissionForms(
  admission: (reviewer: "alice" | "bob" | "carol", overrides?: Record<string, unknown>) => unknown,
  revocation: (reviewer: "alice" | "bob" | "carol", reason?: string) => unknown,
  pub: (n: KeyName) => string
): ReviewVectors["admission_forms"] {
  const admit = admission("alice") as Record<string, unknown>;
  const revoke = revocation("bob") as Record<string, unknown>;
  const key = (id: string, n: KeyName) => ({ key_id: id, public_key: pub(n) });
  const twentyOne = Array.from({ length: 21 }, (_, i) => ({ key_id: `k${String(i).padStart(2, "0")}`, public_key: pub("dave") }));
  const forms: [string, unknown, "valid" | "invalid"][] = [
    ["admit", admit, "valid"],
    ["admit_two_keys_sorted", admission("alice", { keys: [key("vectors-1", "dave"), key("vectors-2", "bob_k1")], probation_days: 365 }), "valid"],
    ["revoke", revoke, "valid"],
    ["revoke_reason_500", revocation("bob", "x".repeat(500)), "valid"],
    ["unknown_field", { ...admit, note: "x" }, "invalid"],
    ["admit_with_a_reason", { ...admit, reason: "vetted" }, "invalid"],
    ["admit_without_arms_length", (({ arms_length: _a, ...rest }) => rest)(admit), "invalid"],
    ["arms_length_false", { ...admit, arms_length: false }, "invalid"],
    ["probation_89_days", { ...admit, probation_days: 89 }, "invalid"],
    ["probation_366_days", { ...admit, probation_days: 366 }, "invalid"],
    ["probation_fractional", { ...admit, probation_days: 90.5 }, "invalid"],
    ["probation_as_text", { ...admit, probation_days: "90" }, "invalid"],
    ["keys_out_of_order", { ...admit, keys: [key("vectors-2", "bob_k1"), key("vectors-1", "dave")] }, "invalid"],
    ["key_id_twice", { ...admit, keys: [key("vectors-1", "dave"), key("vectors-1", "bob_k1")] }, "invalid"],
    ["public_key_twice", { ...admit, keys: [key("vectors-1", "dave"), key("vectors-2", "dave")] }, "invalid"],
    ["no_keys", { ...admit, keys: [] }, "invalid"],
    ["twenty_one_keys", { ...admit, keys: twentyOne }, "invalid"],
    ["key_with_an_extra_field", { ...admit, keys: [{ ...key("vectors-1", "dave"), status: "active" }] }, "invalid"],
    ["key_in_a_second_spelling", { ...admit, keys: [{ key_id: "vectors-1", public_key: `${pub("dave").slice(0, -1)}_` }] }, "invalid"],
    ["uppercase_org", { ...admit, counteraudit_org_id: FURNISHER_ORG.replace("b2", "B2") }, "invalid"],
    ["revoke_naming_keys", { ...revoke, keys: admit.keys }, "invalid"],
    ["revoke_naming_an_org", { ...revoke, counteraudit_org_id: FURNISHER_ORG }, "invalid"],
    ["revoke_without_a_reason", (({ reason: _r, ...rest }) => rest)(revoke), "invalid"],
    ["revoke_blank_reason", { ...revoke, reason: "   " }, "invalid"],
    ["revoke_reason_501", { ...revoke, reason: "x".repeat(501) }, "invalid"],
    ["another_decision", { ...admit, decision: "suspend" }, "invalid"],
    ["bad_furnisher_id", { ...admit, furnisher_id: "fur_X" }, "invalid"],
    ["time_without_milliseconds", { ...admit, decided_at: "2026-11-01T11:00:00Z" }, "invalid"],
    ["unsigned", (({ signature: _s, ...rest }) => rest)(admit), "invalid"],
  ];
  return forms.map(([id, record, expect]) => ({ id, record, expect }));
}

/** The file's exact text: two-space JSON and a final newline. */
export function reviewVectorsText(): string {
  return `${JSON.stringify(buildReviewVectors(), null, 2)}\n`;
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith("review-vectors")) {
  mkdirSync(path.dirname(VECTORS_PATH), { recursive: true });
  writeFileSync(VECTORS_PATH, reviewVectorsText());
  console.log(`Wrote ${VECTORS_PATH}`);
}
