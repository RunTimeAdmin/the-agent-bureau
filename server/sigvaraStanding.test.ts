import { describe, expect, it } from "vitest";
import {
  checkSigvaraStanding,
  parseSigvaraDid,
  readSigvaraStanding,
  sigvaraDidHash,
  SIGVARA_ARC_TESTNET,
  type SigvaraClient,
} from "./sigvaraStanding";

// The demo agent on Arc testnet, whose didHash Sigvara's oracle and CounterAudit both use.
const AGENT = "0xCc52Cd92963f8A86d04dB29a4810d1e01D193910";
const DID_HASH =
  "0x8414ce0bf4f1e1695193623e0a656a9439e356f8bed0b8bf249b179fe77c7e19";
const SUBJECT = { did: `did:sigvara:5042002:${AGENT}` };
// When the file was issued: a few seconds after the block below.
const ISSUED = "2026-11-01T02:29:45.000Z";
const BLOCK = {
  number: 70108525n,
  hash: `0x${"2c".repeat(32)}` as const,
  timestamp: 1793500179n,
};

// A chain that answers as Arc testnet did for the demo agent, unless told otherwise.
function chain(
  overrides: Partial<SigvaraClient> = {},
  seen: bigint[] = []
): SigvaraClient {
  return {
    chainId: async () => 5042002,
    finalizedBlock: async () => BLOCK,
    block: async number => ({ ...BLOCK, number }),
    identity: async (_, at) => {
      seen.push(at);
      return { agentAddress: AGENT, status: 0, registeredAt: 1789695433n };
    },
    reputation: async () => ({
      feeScore: 20,
      successScore: 8,
      ageScore: 3,
      externalScore: 0,
      communityScore: 5,
      propagationScore: 0,
      lastUpdated: 1793485345n,
    }),
    totalScore: async () => 36,
    stake: async () => 5_000_000_000_000_000_000_000n,
    hasMinimumStake: async () => true,
    ...overrides,
  };
}

describe("a Sigvara agent's DID", () => {
  it("hashes as SigvaraIdentity hashes it", () => {
    expect(sigvaraDidHash(5042002, AGENT)).toBe(DID_HASH);
    expect(sigvaraDidHash(5042002, AGENT.toLowerCase() as `0x${string}`)).toBe(
      DID_HASH
    );
  });

  it("is read only from a did:sigvara subject, with the address in any case", () => {
    const lower = AGENT.toLowerCase();
    expect(parseSigvaraDid(SUBJECT)).toEqual({
      chainId: 5042002,
      address: lower,
    });
    expect(parseSigvaraDid({ did: `did:sigvara:5042002:${lower}` })).toEqual({
      chainId: 5042002,
      address: lower,
    });
    expect(
      parseSigvaraDid({
        did: `did:sigvara:5042002:${AGENT.toUpperCase().replace("0X", "0x")}`,
      })
    ).toEqual({
      chainId: 5042002,
      address: lower,
    });
    for (const other of [
      { wallet: AGENT },
      { did: `did:pkh:eip155:1:${AGENT}` },
      { did: `did:sigvara:5042002:${AGENT}:extra` },
      // A chain id with a leading zero is another spelling of the same agent.
      { did: `did:sigvara:05042002:${AGENT}` },
      { did: SUBJECT.did, extra: 1 },
      { chain: "arc", registry: "sigvara", id: AGENT },
    ]) {
      expect(parseSigvaraDid(other)).toBeNull();
    }
  });
});

describe("readSigvaraStanding", () => {
  it("reads status, score and stake at one finalized block, and names it", async () => {
    expect(await readSigvaraStanding(SUBJECT, chain())).toEqual({
      source: "Sigvara",
      network: "Arc testnet (chain 5042002)",
      label: expect.stringContaining("not the Bureau's verdict"),
      did_hash: DID_HASH,
      read_at: {
        block_number: "70108525",
        block_hash: BLOCK.hash,
        block_time: "2026-11-01T02:29:39.000Z",
        finality: "finalized",
      },
      contracts: {
        identity: SIGVARA_ARC_TESTNET.identity,
        reputation: SIGVARA_ARC_TESTNET.reputation,
        staking: SIGVARA_ARC_TESTNET.staking,
      },
      status: "Active",
      registered_at: "2026-09-18T01:37:13.000Z",
      score: {
        total: 36,
        fee: 20,
        success: 8,
        age: 3,
        external: 0,
        community: 5,
        propagation: 0,
        last_updated: "2026-10-31T22:22:25.000Z",
      },
      stake: "5000000000000000000000",
      has_minimum_stake: true,
    });
  });

  it("says an agent Sigvara does not know is not registered", async () => {
    const unknown = chain({
      identity: async () => ({
        agentAddress: `0x${"0".repeat(40)}`,
        status: 0,
        registeredAt: 0n,
      }),
    });
    expect(await readSigvaraStanding(SUBJECT, unknown)).toMatchObject({
      status: "not_registered",
      score: null,
      stake: null,
      has_minimum_stake: null,
    });
  });

  it("has nothing to say about another subject or another chain", async () => {
    expect(await readSigvaraStanding({ wallet: AGENT }, chain())).toBeNull();
    expect(
      await readSigvaraStanding({ did: `did:sigvara:1:${AGENT}` }, chain())
    ).toBeNull();
  });

  it("refuses a node on another chain, and an identity for another agent", async () => {
    await expect(
      readSigvaraStanding(SUBJECT, chain({ chainId: async () => 1 }))
    ).rejects.toThrow("serves chain 1");
    const swapped = chain({
      identity: async () => ({
        agentAddress: `0x${"1".repeat(40)}`,
        status: 0,
        registeredAt: 1n,
      }),
    });
    await expect(readSigvaraStanding(SUBJECT, swapped)).rejects.toThrow(
      "names agent"
    );
    await expect(
      readSigvaraStanding(
        SUBJECT,
        chain({
          identity: async () => ({
            agentAddress: AGENT,
            status: 9,
            registeredAt: 1n,
          }),
        })
      )
    ).rejects.toThrow("unknown status");
  });

  it("reads at the block it is given", async () => {
    const seen: bigint[] = [];
    const got = await readSigvaraStanding(SUBJECT, chain({}, seen), 70000000n);
    expect(seen).toEqual([70000000n]);
    expect(got?.read_at.block_number).toBe("70000000");
  });
});

describe("checkSigvaraStanding", () => {
  it("passes a standing the contracts still give at its block, read when the file was issued", async () => {
    const entry = await readSigvaraStanding(SUBJECT, chain());
    expect(await checkSigvaraStanding(SUBJECT, entry, chain(), ISSUED)).toEqual(
      { ok: true }
    );
    // The same agent spelled in lowercase reads the same standing.
    const lower = { did: SUBJECT.did.toLowerCase() };
    expect(await checkSigvaraStanding(lower, entry, chain(), ISSUED)).toEqual({
      ok: true,
    });
  });

  it("fails an entry worded or shaped otherwise than this code reads it", async () => {
    const entry = (await readSigvaraStanding(SUBJECT, chain()))!;
    for (const changed of [
      { ...entry, label: "Bureau-endorsed: low risk" },
      { ...entry, network: "Ethereum mainnet" },
      { ...entry, read_at: { ...entry.read_at, finality: "latest" } },
      { ...entry, verdict: "approved" },
    ]) {
      expect(
        (await checkSigvaraStanding(SUBJECT, changed, chain(), ISSUED)).ok
      ).toBe(false);
    }
  });

  it("fails a block that is not finalized, or one read long before the file was issued", async () => {
    const entry = await readSigvaraStanding(SUBJECT, chain());
    const behind = chain({
      finalizedBlock: async () => ({ ...BLOCK, number: BLOCK.number - 1n }),
    });
    expect(
      await checkSigvaraStanding(SUBJECT, entry, behind, ISSUED)
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not finalized"),
    });
    expect(
      (
        await checkSigvaraStanding(
          SUBJECT,
          entry,
          chain(),
          "2026-11-02T00:00:00.000Z"
        )
      ).ok
    ).toBe(false);
    expect(
      (
        await checkSigvaraStanding(
          SUBJECT,
          entry,
          chain(),
          "2026-11-01T02:00:00.000Z"
        )
      ).ok
    ).toBe(false);
    expect(
      (await checkSigvaraStanding(SUBJECT, entry, chain(), "not a date")).ok
    ).toBe(false);
  });

  it("fails one the contracts do not give, or on another block", async () => {
    const entry = (await readSigvaraStanding(SUBJECT, chain()))!;
    const raised = { ...entry, score: { ...entry.score!, total: 50 } };
    expect(
      (await checkSigvaraStanding(SUBJECT, raised, chain(), ISSUED)).ok
    ).toBe(false);
    const otherBlock = {
      ...entry,
      read_at: { ...entry.read_at, block_hash: `0x${"ab".repeat(32)}` },
    };
    expect(
      (await checkSigvaraStanding(SUBJECT, otherBlock, chain(), ISSUED)).ok
    ).toBe(false);
    const suspended = chain({
      identity: async () => ({
        agentAddress: AGENT,
        status: 1,
        registeredAt: 1789695433n,
      }),
    });
    expect(
      (await checkSigvaraStanding(SUBJECT, entry, suspended, ISSUED)).ok
    ).toBe(false);
  });

  it("fails when the chain cannot be read, or the entry is not one", async () => {
    const entry = await readSigvaraStanding(SUBJECT, chain());
    const down = chain({
      block: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(await checkSigvaraStanding(SUBJECT, entry, down, ISSUED)).toEqual({
      ok: false,
      detail: "connect ECONNREFUSED",
    });
    expect(
      (
        await checkSigvaraStanding(
          SUBJECT,
          { read_at: { block_number: "x" } },
          chain(),
          ISSUED
        )
      ).ok
    ).toBe(false);
    expect(
      (await checkSigvaraStanding({ wallet: AGENT }, entry, chain(), ISSUED)).ok
    ).toBe(false);
  });
});
