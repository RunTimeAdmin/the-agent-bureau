// lineNow for a did:sigvara subject: its records are checked against SigvaraIdentity as it stands now,
// where a file used what a sync read when it stored them (server/agentFile.ts).
import { generatePrivateKey } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({}));

import { disputeRowsByLine, lineFromSeal, lineNow } from "./agentFile";
import { DISPUTE_SCHEMA, signWithWallet, walletAddress } from "./dispute";
import { signedEventHash } from "./outcomeProof";
import type { ReviewLog } from "./reviewLog";
import { SIGVARA_ARC_TESTNET, type SigvaraClient } from "./sigvaraStanding";

const KEY = generatePrivateKey();
const ADDRESS = walletAddress(KEY);
const ORG = "4702bb18-c7e5-4cfc-93e2-e0eab848e5c1";
const SUBJECT = { did: `did:sigvara:${SIGVARA_ARC_TESTNET.chainId}:${ADDRESS}` };
const SEALED_AT = new Date("2026-11-02T12:00:00.000Z");
const seconds = (at: Date) => BigInt(Math.floor(at.getTime() / 1000));

const event = {
  schema_version: "1",
  furnisher_id: "fur_bureaupilot01",
  key_id: "pilot-2026-10",
  event_id: "event-1",
  subject_ref: SUBJECT,
  occurred_at: "2026-10-31T10:00:00.000Z",
  outcome: "delivered",
  signature: "ed25519:checked-by-counteraudit-when-sealed",
};
const hash = signedEventHash(event);
const log = {
  admissions: [],
  decisions: [
    {
      sequence: 1,
      packetId: "a0000000-0000-4000-8000-000000000001",
      suspended: false,
      sealedAt: new Date("2026-11-01T12:00:00.000Z"),
      decision: {
        reviewer_id: "rev_alice",
        furnisher_id: event.furnisher_id,
        event_id: event.event_id,
        signed_event_hash: hash,
        data_class: "test",
        evidence_digest: "0".repeat(64),
        decision: "approve",
        decided_at: "2026-11-01T11:00:00.000Z",
      },
    },
  ],
} as unknown as ReviewLog;

const client = (registeredAt: bigint, reachable = true) =>
  ({
    chainId: vi.fn(async () => {
      if (!reachable) throw new Error("no answer");
      return SIGVARA_ARC_TESTNET.chainId;
    }),
    finalizedBlock: vi.fn(async () => ({ number: 100n, hash: `0x${"1".repeat(64)}`, timestamp: seconds(SEALED_AT) })),
    identity: vi.fn(async () => ({ agentAddress: ADDRESS, status: 1, registeredAt })),
  }) as unknown as SigvaraClient;

describe("lineNow and a did:sigvara subject", () => {
  let dispute: unknown;
  beforeEach(async () => {
    process.env.COUNTERAUDIT_ORG_ID = ORG;
    dispute = await signWithWallet(
      {
        schema: DISPUTE_SCHEMA,
        kind: "dispute",
        dispute_id: "6d1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b",
        line: { furnisher_id: event.furnisher_id, event_id: event.event_id, signed_event_hash: hash },
        subject_ref: SUBJECT,
        signer: { type: "eip191", address: ADDRESS },
        reason: "I never received this.",
        filed_at: SEALED_AT.toISOString(),
      },
      KEY
    );
  });

  const run = (sigvara: SigvaraClient, shown?: unknown) => {
    const line = lineFromSeal({ packetId: "29879d36-0000-4000-8000-000000000001", sequence: 7, sealedAt: new Date("2026-10-31T11:00:01.000Z"), event });
    if (!line) throw new Error("the event did not read");
    const lines = [line];
    const disputes = [{ packetId: "d0000000-0000-4000-8000-000000000000", sequence: 200, sealedAt: SEALED_AT, record: dispute }];
    return lineNow(
      { data_class: "test", released: "solo_test", display_state: shown ? "disputed" : "released", ...(shown ? { dispute: shown } : {}) },
      { packet_id: "29879d36-0000-4000-8000-000000000001", org_id: ORG, signed_event_hash: hash },
      { outcome_claim: {} },
      { log, disputeRows: disputeRowsByLine(disputes, lines), lines },
      { furnishers: {}, now: () => new Date(SEALED_AT.getTime() + 86_400_000), sigvara }
    );
  };
  const OPEN = { state: "open", filed_at: SEALED_AT.toISOString(), respond_by: "2026-11-17T12:00:00.000Z" };

  it("fails on a dispute sealed after the agent registered, which any sync would count too", async () => {
    const found = await run(client(seconds(SEALED_AT) - 60n));
    expect(found).toMatchObject({ problem: expect.stringContaining('"state":"open"') });
  });

  it("passes a file that shows that dispute", async () => {
    expect(await run(client(seconds(SEALED_AT) - 60n), OPEN)).toBeNull();
  });

  it("cannot say for a dispute sealed before the agent registered, which a sync may have read either way", async () => {
    const found = await run(client(seconds(SEALED_AT) + 60n));
    expect(found).toMatchObject({ unknown: expect.stringContaining("earlier read of SigvaraIdentity") });
  });

  it("cannot say when the registry no longer holds the agent a file shows a dispute from", async () => {
    const found = await run(client(0n), OPEN);
    expect(found).toMatchObject({ unknown: expect.stringContaining("no dispute counts") });
  });

  it("cannot say when Sigvara cannot be read", async () => {
    const found = await run(client(1n, false));
    expect(found).toMatchObject({ unknown: expect.stringContaining("could not be checked") });
  });
});
