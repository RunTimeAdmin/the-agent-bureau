import { readFileSync } from "node:fs";
import path from "node:path";
import { encodeAbiParameters, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  chargeKey,
  verifyEvidence,
  type ChainReader,
  type ReceiptLog,
} from "./evidence";

// Three real Levy transactions on Arc testnet, read over RPC on 2026-10-31
// with their blocks and the subscription and plan state at those blocks and
// the block before. Anyone can fetch them again from
// https://rpc.testnet.arc.io.
type FixtureState = {
  subscriptions: Record<
    string,
    { subscriber: Hex; planId: string; credit: string }
  >;
  plans: Record<string, { merchant: Hex; price: string }>;
};
type FixtureTx = FixtureState & {
  receipt: {
    status: "success" | "reverted";
    blockNumber: string;
    blockHash: Hex;
    logs: ReceiptLog[];
  };
  block: { hash: Hex; timestamp: string };
  before: FixtureState;
};
const fixture: {
  chain_id: number;
  finalized_block: string;
  transactions: Record<string, FixtureTx>;
} = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "fixtures", "arc-levy", "charges.json"),
    "utf8"
  )
);

// Subscription 8's first cycle, pulled at subscribe: 1 USDC.
const PAID =
  "0xd6fbaf6ec24b0ae502b0dd4e3360619eb9052652ecbaf51ae5566d86ad6aafe5";
// A keeper renewal of subscription 1, whose merchant pays itself.
const RENEWAL =
  "0xeecfc179fe52ca59cb5d47f693f32e4916f16d1f881af56c51a835ceea84c71d";
// Subscription 3's second failed pull.
const FAILED =
  "0xe9c5a519d11ebd2d7d5281bf001d1aadcace642ca5ab38c66f9a6fa63f24bff4";
const MANAGER = "0xea24ac9c1217a671139d93225fdcf19ea3c4df4e";
const USDC = "0x3600000000000000000000000000000000000000";
const MERCHANT = "0x83F45b842c15c1417fDbCE296D966b1CE17544bD";
const PAYER = "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77";
const FAILED_PAYER = "0x451567A35648445143768d3D6e9072A50BB2d85F";
const FURNISHER = "fur_levymerchant1";
const ACCOUNTS = {
  [FURNISHER]: [{ chain: "arc-testnet", address: MERCHANT }],
} as const;

function blockTime(hash: string): string {
  const seconds = Number(fixture.transactions[hash].block.timestamp);
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function fixtureReader(
  overrides: Partial<ChainReader> = {},
  txs: Record<string, FixtureTx> = fixture.transactions
): ChainReader {
  const at = (blockNumber: bigint) => {
    const tx = Object.values(txs).find(
      t => BigInt(t.receipt.blockNumber) === blockNumber
    );
    if (!tx) throw new Error(`no block ${blockNumber} in the fixture`);
    return tx;
  };
  // Contract state at a transaction's block, or at the block before it.
  const state = (blockNumber: bigint): FixtureState => {
    const tx = Object.values(txs).find(
      t => BigInt(t.receipt.blockNumber) === blockNumber + 1n
    );
    return tx ? tx.before : at(blockNumber);
  };
  return {
    chainId: async () => fixture.chain_id,
    finalizedBlockNumber: async () => BigInt(fixture.finalized_block),
    block: async n => ({
      hash: at(n).block.hash,
      timestamp: BigInt(at(n).block.timestamp),
    }),
    receipt: async hash => {
      const tx = txs[hash];
      return tx
        ? { ...tx.receipt, blockNumber: BigInt(tx.receipt.blockNumber) }
        : null;
    },
    subscription: async (_manager, subId, n) => {
      const sub = state(n).subscriptions[subId.toString()];
      return {
        subscriber: sub.subscriber,
        planId: BigInt(sub.planId),
        credit: BigInt(sub.credit),
      };
    },
    plan: async (_manager, planId, n) => {
      const plan = state(n).plans[planId.toString()];
      return { merchant: plan.merchant, price: BigInt(plan.price) };
    },
    ...overrides,
  };
}

// The same fixture with one transaction's logs replaced.
function withLogs(hash: string, logs: ReceiptLog[]) {
  const tx = fixture.transactions[hash];
  return {
    ...fixture.transactions,
    [hash]: { ...tx, receipt: { ...tx.receipt, logs } },
  };
}

function paidEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    furnisher_id: FURNISHER,
    key_id: "levy-2026-10",
    event_id: "levy-sub8-charge1",
    subject_ref: { wallet: PAYER },
    occurred_at: blockTime(PAID),
    outcome: "paid",
    amount: { value: "1.00", asset: "USDC", chain: "arc-testnet" },
    evidence: { tx_hash: PAID },
    signature: `ed25519:${"A".repeat(86)}`,
    ...overrides,
  };
}

function failedEvent(overrides: Record<string, unknown> = {}) {
  return paidEvent({
    event_id: "levy-sub3-failed2",
    outcome: "payment_failed",
    subject_ref: { wallet: FAILED_PAYER },
    occurred_at: blockTime(FAILED),
    amount: { value: "1", asset: "USDC", chain: "arc-testnet" },
    evidence: { tx_hash: FAILED, log_ref: "levy keeper charge 3" },
    ...overrides,
  });
}

// Checked days after the fixtures settled (29 and 30 October 2026), well inside the retention baseline.
const CHECKED_AT = new Date("2026-11-01T00:00:00.000Z");
const deps = (reader = fixtureReader(), now = CHECKED_AT) => ({
  accounts: ACCOUNTS,
  reader: () => reader,
  now: () => now,
});

describe("verifyEvidence: Levy on Arc testnet", () => {
  it("verifies a paid line against the Charged log and the USDC that settled it", async () => {
    const result = await verifyEvidence(paidEvent(), deps());
    expect(result).toEqual({
      verifier: "levy-arc/1",
      status: "verified",
      reasons: [],
      charge: {
        kind: "charged",
        chain: "arc-testnet",
        chain_id: 5042002,
        tx_hash: PAID,
        log_index: 14,
        block_number: "69882369",
        block_hash: fixture.transactions[PAID].receipt.blockHash,
        block_time: new Date(
          Number(fixture.transactions[PAID].block.timestamp) * 1000
        ).toISOString(),
        contract: MANAGER,
        token: USDC,
        sub_id: "8",
        payer: PAYER,
        recipient: MERCHANT,
        amount: "1000000",
      },
      recipient_confirmed: true,
    });
    expect(chargeKey(result.charge!)).toBe(`5042002:${PAID}:14`);
  });

  it("matches a keeper renewal, and sends a merchant paying itself to review", async () => {
    const result = await verifyEvidence(
      paidEvent({
        subject_ref: { wallet: MERCHANT.toLowerCase() },
        occurred_at: blockTime(RENEWAL),
        amount: { value: "1.000000", asset: "USDC", chain: "arc-testnet" },
        evidence: { tx_hash: RENEWAL },
      }),
      deps()
    );
    expect(result.status).toBe("needs_review");
    expect(result.reasons).toEqual([
      "the payer is the merchant or another of the furnisher's own accounts, so the charge is not with another party",
    ]);
    expect(result.charge).toMatchObject({ sub_id: "1", payer: MERCHANT });
  });

  it("takes no charge older than the retention baseline, since its claim may have been erased", async () => {
    const settled = new Date(blockTime(PAID));
    const lastDay = new Date(settled);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 24);
    const late = await verifyEvidence(
      paidEvent(),
      deps(fixtureReader(), new Date(lastDay.getTime() + 1000))
    );
    expect(late.status).toBe("failed");
    expect(late.reasons).toContain(
      `the charge settled at ${settled.toISOString()}, more than 24 months ago, past the retention baseline`
    );
    const inTime = await verifyEvidence(
      paidEvent(),
      deps(fixtureReader(), new Date(lastDay.getTime() - 1000))
    );
    expect(inTime.status).toBe("verified");
  });

  it("verifies a payment_failed line against ChargeFailed, with the amount that was due", async () => {
    const result = await verifyEvidence(failedEvent(), deps());
    expect(result.status).toBe("verified");
    expect(result.charge).toMatchObject({
      kind: "charge_failed",
      log_index: 16,
      sub_id: "3",
      payer: FAILED_PAYER,
      recipient: MERCHANT,
      amount: "1000000",
    });
  });

  it("does not read the chain for an outcome with no machine check", async () => {
    const reader = fixtureReader({
      chainId: async () => {
        throw new Error("must not be called");
      },
    });
    const result = await verifyEvidence(
      paidEvent({ outcome: "delivered", amount: undefined }),
      deps(reader)
    );
    expect(result).toEqual({
      verifier: null,
      status: "needs_review",
      reasons: ["no machine check exists for delivered outcomes"],
    });
  });

  it.each([
    [
      "a chain with no verifier",
      { amount: { value: "1", asset: "USDC", chain: "base" } },
      "no verifier for chain base",
    ],
    [
      "Arc mainnet, where Levy is not deployed",
      { amount: { value: "1", asset: "USDC", chain: "arc" } },
      "no verifier for chain arc",
    ],
    [
      "another asset",
      { amount: { value: "1", asset: "EURC", chain: "arc-testnet" } },
      "no verifier for EURC",
    ],
    [
      "no transaction hash",
      { evidence: { log_ref: "invoice 12" } },
      "names no transaction",
    ],
  ])("sends %s to review", async (_name, overrides, reason) => {
    const result = await verifyEvidence(paidEvent(overrides), deps());
    expect(result.status).toBe("needs_review");
    expect(result.reasons.join(" ")).toContain(reason);
  });

  it.each([
    [
      "a different amount",
      { amount: { value: "1.5", asset: "USDC", chain: "arc-testnet" } },
      "no Charged log matches",
    ],
    [
      "more decimals than USDC has",
      { amount: { value: "1.0000001", asset: "USDC", chain: "arc-testnet" } },
      "more than 6 decimal places",
    ],
    [
      "a different payer",
      { subject_ref: { wallet: FAILED_PAYER } },
      "no Charged log matches",
    ],
    [
      "a malformed hash",
      { evidence: { tx_hash: "0x1234" } },
      "not a 0x-prefixed 32-byte transaction hash",
    ],
    [
      "a failed charge reported as paid",
      { evidence: { tx_hash: FAILED } },
      "no Levy Charged log",
    ],
    [
      "an occurred_at two days off",
      { occurred_at: "2026-10-27T00:00:00Z" },
      "more than 24 hours",
    ],
  ])("fails %s", async (_name, overrides, reason) => {
    const result = await verifyEvidence(paidEvent(overrides), deps());
    expect(result.status).toBe("failed");
    expect(result.reasons.join(" ")).toContain(reason);
  });

  it("treats a transaction the RPC cannot find as not final yet, not as a verdict", async () => {
    const result = await verifyEvidence(
      paidEvent({ evidence: { tx_hash: `0x${"ab".repeat(32)}` } }),
      deps()
    );
    expect(result.status).toBe("pending");
    expect(result.reasons[0]).toContain("or the RPC has not seen it yet");
  });

  it("fails a paid charge whose merchant belongs to someone other than the furnisher", async () => {
    const result = await verifyEvidence(paidEvent(), {
      accounts: {
        [FURNISHER]: [{ chain: "arc-testnet", address: FAILED_PAYER }],
      },
      reader: () => fixtureReader(),
    });
    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual([
      `the charge's merchant ${MERCHANT} is not an account of ${FURNISHER}`,
    ]);
    expect(result.recipient_confirmed).toBe(false);
  });

  it("sends a furnisher with no vetted account to review, keeping what it found", async () => {
    const result = await verifyEvidence(paidEvent(), {
      accounts: {},
      reader: () => fixtureReader(),
    });
    expect(result.status).toBe("needs_review");
    expect(result.reasons[0]).toContain("has no vetted merchant account");
    expect(result.charge?.log_index).toBe(14);
    expect(result.recipient_confirmed).toBe(false);
  });

  it("sends a failed charge to review when the amount due changed within its block", async () => {
    const tx = fixture.transactions[FAILED];
    const txs = {
      ...fixture.transactions,
      [FAILED]: {
        ...tx,
        before: {
          ...tx.before,
          plans: { 1: { merchant: MERCHANT, price: "2000000" } },
        },
      },
    };
    for (const value of ["1", "2"]) {
      const result = await verifyEvidence(
        failedEvent({ amount: { value, asset: "USDC", chain: "arc-testnet" } }),
        deps(fixtureReader({}, txs))
      );
      expect(result.status).toBe("needs_review");
      expect(result.reasons).toEqual([
        "the subscription changed within block 69707223, so the amount due was 2 or 1 USDC",
      ]);
    }
  });

  it("sends a transaction with more charge logs than it checks to review, without reading them", async () => {
    const log = fixture.transactions[FAILED].receipt.logs[0];
    const logs = Array.from({ length: 21 }, (_, i) => ({
      ...log,
      logIndex: i,
    }));
    const reader = fixtureReader(
      {
        subscription: async () => {
          throw new Error("must not be called");
        },
      },
      withLogs(FAILED, logs)
    );
    const result = await verifyEvidence(failedEvent(), deps(reader));
    expect(result).toEqual({
      verifier: "levy-arc/1",
      status: "needs_review",
      reasons: [
        "the transaction has 21 Levy charge logs of this kind, more than the 20 checked automatically",
      ],
    });
  });

  it("sends a DID subject to review, since matching it to the payer is not built", async () => {
    const result = await verifyEvidence(
      paidEvent({ subject_ref: { did: `did:sigvara:5042002:${PAYER}` } }),
      deps()
    );
    expect(result.status).toBe("needs_review");
    expect(result.reasons[0]).toContain("not an EVM wallet");
    expect(result.charge?.payer).toBe(PAYER);
  });

  it("ignores Arc's native 18-decimal mirror logs: without the ERC-20 transfers a Charged log fails", async () => {
    const logs = fixture.transactions[PAID].receipt.logs.filter(
      log => log.address.toLowerCase() !== USDC
    );
    const result = await verifyEvidence(
      paidEvent(),
      deps(fixtureReader({}, withLogs(PAID, logs)))
    );
    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual([
      "the USDC transfers in the transaction do not match its Charged log",
    ]);
  });

  it("ignores Charged logs from a contract that is not Levy's", async () => {
    const impostor = "0x00000000000000000000000000000000000000aa";
    const logs = fixture.transactions[PAID].receipt.logs.map(log =>
      log.address.toLowerCase() === MANAGER
        ? { ...log, address: impostor }
        : log
    ) as ReceiptLog[];
    const result = await verifyEvidence(
      paidEvent(),
      deps(fixtureReader({}, withLogs(PAID, logs)))
    );
    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual(["the transaction has no Levy Charged log"]);
  });

  it("fails a cycle paid from proration credit, where no USDC moved", async () => {
    const logs = fixture.transactions[PAID].receipt.logs.map(log =>
      log.logIndex === 14
        ? {
            ...log,
            data: encodeAbiParameters(
              [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
              [0n, 0n, 1n]
            ),
          }
        : log
    );
    const result = await verifyEvidence(
      paidEvent({
        amount: { value: "0", asset: "USDC", chain: "arc-testnet" },
      }),
      deps(fixtureReader({}, withLogs(PAID, logs)))
    );
    expect(result.status).toBe("failed");
    expect(result.reasons[0]).toContain("proration credit");
  });

  it("sends two matching charges in one transaction to review", async () => {
    const logs = fixture.transactions[PAID].receipt.logs;
    const repeated = logs
      .filter(log => log.logIndex > 7)
      .map(log => ({ ...log, logIndex: log.logIndex + 7 }));
    const result = await verifyEvidence(
      paidEvent(),
      deps(fixtureReader({}, withLogs(PAID, [...logs, ...repeated])))
    );
    expect(result.status).toBe("needs_review");
    expect(result.reasons).toEqual([
      "2 Charged logs in the transaction match the event",
    ]);
  });

  it("waits for a block above the finalized one", async () => {
    const reader = fixtureReader({
      finalizedBlockNumber: async () => 69882368n,
    });
    const result = await verifyEvidence(paidEvent(), deps(reader));
    expect(result.status).toBe("pending");
    expect(result.reasons[0]).toContain("not finalized yet");
  });

  it("does not trust a receipt whose block hash the RPC no longer serves", async () => {
    const reader = fixtureReader({
      block: async () => ({ hash: `0x${"00".repeat(32)}`, timestamp: 0n }),
    });
    const result = await verifyEvidence(paidEvent(), deps(reader));
    expect(result.status).toBe("error");
    expect(result.reasons[0]).toContain("differs from the receipt's");
  });

  it("refuses an RPC that serves another chain", async () => {
    const reader = fixtureReader({ chainId: async () => 5042 });
    const result = await verifyEvidence(paidEvent(), deps(reader));
    expect(result).toMatchObject({
      status: "error",
      reasons: ["the RPC serves chain 5042, not 5042002"],
    });
  });

  it("fails a reverted transaction", async () => {
    const tx = fixture.transactions[PAID];
    const txs = {
      ...fixture.transactions,
      [PAID]: {
        ...tx,
        receipt: { ...tx.receipt, status: "reverted" as const },
      },
    };
    const result = await verifyEvidence(
      paidEvent(),
      deps(fixtureReader({}, txs))
    );
    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual([`transaction ${PAID} reverted`]);
  });

  it("returns an error, not a throw, when the RPC cannot be read", async () => {
    const reader = fixtureReader({
      receipt: async () => {
        throw new Error("fetch failed\nstack");
      },
    });
    const result = await verifyEvidence(paidEvent(), deps(reader));
    expect(result).toEqual({
      verifier: "levy-arc/1",
      status: "error",
      reasons: ["chain read failed: fetch failed"],
    });
  });
});

// Reads Arc testnet itself: ARC_LIVE=1 pnpm test server/evidence.test.ts
describe.skipIf(!process.env.ARC_LIVE)(
  "verifyEvidence against Arc testnet",
  () => {
    it.each([
      ["paid", paidEvent()],
      ["payment_failed", failedEvent()],
    ])("verifies the fixture's %s line over RPC", async (_name, event) => {
      const live = await verifyEvidence(event, { accounts: ACCOUNTS });
      const recorded = await verifyEvidence(event, deps());
      expect(live.status).toBe("verified");
      expect(live).toEqual(recorded);
    });
  }
);

describe("verifyEvidence: the funding screen", () => {
  const screenReads = (calls: string[]) => () => ({
    index: {
      async transfers(_wallet: string, direction: string) {
        calls.push(direction);
        return { items: [], complete: true };
      },
      async transactionTransfers() {
        return { items: [], complete: true };
      },
      async blockAtOrBefore() {
        return 1n;
      },
      async indexingFinished() {
        return true;
      },
    },
    state: { nonceAt: async () => 3, balanceAt: async () => 5n, blockTime: async () => 0 },
  });

  it("screens a settled charge and keeps the evidence status as the chain decided it", async () => {
    const calls: string[] = [];
    const result = await verifyEvidence(paidEvent(), { ...deps(), screen: screenReads(calls) });
    expect(result.status).toBe("verified");
    expect(result.funding_screen).toMatchObject({ screen: "arc-funding/1", result: "flagged" });
    expect(result.funding_screen?.flags.join(" ")).toMatch(/no other merchant payment/);
    expect(calls).toEqual(["in", "out"]);
  });

  it("does not screen a failed line, or when the test gives a reader and no screen", async () => {
    const calls: string[] = [];
    const failed = await verifyEvidence(paidEvent({ amount: { value: "2.00", asset: "USDC", chain: "arc-testnet" } }), { ...deps(), screen: screenReads(calls) });
    expect(failed.status).toBe("failed");
    expect(failed.funding_screen).toBeUndefined();
    expect((await verifyEvidence(paidEvent(), deps())).funding_screen).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
