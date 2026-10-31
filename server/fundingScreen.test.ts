import { readFileSync } from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { LevyCharge } from "./evidence";
import {
  ENTRIES_PER_WALLET,
  explorerIndex,
  READ_FAILED_GAP,
  screenFunding,
  type Transfer,
  type TransferIndex,
  type WalletState,
} from "./fundingScreen";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const MANAGER = "0xea24ac9c1217a671139d93225fdcf19ea3c4df4e" as Address;
const MERCHANT = "0x83F45b842c15c1417fDbCE296D966b1CE17544bD" as Address;
const SECOND_ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const PAYER = "0x090F6D72F49ABaBbD3FfD2ebA26D6B8A374b5b77" as Address;
const FUNDER = "0x5555555555555555555555555555555555555555" as Address;
const OTHER_MERCHANT = "0x7777777777777777777777777777777777777777" as Address;
const END = Date.parse("2026-10-30T18:31:52Z");
const DAY = 24 * 60 * 60 * 1000;

const charge: LevyCharge = {
  kind: "charged",
  chain: "arc-testnet",
  chain_id: 5042002,
  tx_hash: `0x${"c".repeat(64)}` as Hex,
  log_index: 14,
  block_number: "69882369",
  block_hash: `0x${"b".repeat(64)}` as Hex,
  block_time: new Date(END).toISOString(),
  contract: MANAGER,
  token: USDC,
  sub_id: "8",
  payer: PAYER,
  recipient: MERCHANT,
  amount: "1000000",
};

let n = 0;
const tx = () => `0x${(++n).toString(16).padStart(64, "0")}` as Hex;
const transfer = (from: Address, to: Address, daysBefore = 1, value = 1_000_000n, logIndex = 0): Transfer => ({
  from,
  to,
  value,
  block: 69_882_000n,
  time: END - daysBefore * DAY,
  tx: tx(),
  logIndex,
});
const FEE_WALLET = "0x9e62309243Da8bE600a718A323FbBDfCE00f3cE8" as Address;

/** A payer that looks like an ordinary customer: funded by an older wallet, paying another merchant too. */
function world() {
  const otherCharge = transfer(PAYER, MANAGER, 3, 1_000_000n, 1);
  const thisCharge = { ...transfer(PAYER, MANAGER, 0, 1_000_000n, 1), tx: charge.tx_hash };
  return {
    in: new Map<string, { items: Transfer[]; complete: boolean }>([
      [PAYER.toLowerCase(), { items: [transfer(FUNDER, PAYER, 5)], complete: true }],
      [FUNDER.toLowerCase(), { items: [transfer(OTHER_MERCHANT, FUNDER, 9)], complete: true }],
    ]),
    out: new Map<string, { items: Transfer[]; complete: boolean }>([
      [PAYER.toLowerCase(), { items: [thisCharge, otherCharge], complete: true }],
    ]),
    // Each charge pays the merchant and a smaller fee to Levy, after the subscriber's pull.
    txs: new Map<string, Transfer[]>([
      [thisCharge.tx, [thisCharge, transfer(MANAGER, MERCHANT, 0, 990_000n, 2), transfer(MANAGER, FEE_WALLET, 0, 10_000n, 3)]],
      [otherCharge.tx, [otherCharge, transfer(MANAGER, OTHER_MERCHANT, 3, 990_000n, 2), transfer(MANAGER, FEE_WALLET, 3, 10_000n, 3)]],
    ]),
    incompleteTxs: new Set<string>(),
    nonce: 4,
    balance: 2_000_000n,
    indexed: true,
    startBlockTime: END - 31 * DAY,
  };
}
type World = ReturnType<typeof world>;

function reads(w: World, fail?: string): { index: TransferIndex; state: WalletState } {
  return {
    index: {
      async transfers(wallet, direction) {
        if (fail === direction) throw new Error("the explorer answered 502");
        return (direction === "in" ? w.in : w.out).get(wallet.toLowerCase()) ?? { items: [], complete: true };
      },
      async transactionTransfers(hash) {
        return { items: w.txs.get(hash) ?? [], complete: !w.incompleteTxs.has(hash) };
      },
      async blockAtOrBefore() {
        return 64_819_469n;
      },
      async indexingFinished() {
        return w.indexed;
      },
    },
    state: {
      nonceAt: async () => w.nonce,
      balanceAt: async () => w.balance,
      blockTime: async () => w.startBlockTime,
    },
  };
}

const screen = (w: World, accounts: Address[] = [MERCHANT], fail?: string) =>
  screenFunding({ charge, furnisherAccounts: accounts, levyManagers: [MANAGER], ...reads(w, fail) });

describe("screenFunding", () => {
  it("is clear for a payer funded from elsewhere, seen before, that pays other merchants", async () => {
    const result = await screen(world());
    expect(result).toEqual({
      screen: "arc-funding/1",
      result: "clear",
      flags: [],
      gaps: [],
      window_start: new Date(END - 30 * DAY).toISOString(),
      window_end: new Date(END).toISOString(),
    });
  });

  it("flags each sign of a payer related to the furnisher", async () => {
    const cases: [string, (w: World) => void, RegExp][] = [
      ["reciprocal", w => w.in.get(PAYER.toLowerCase())!.items.push(transfer(MERCHANT, PAYER)), /merchant .* also paid the payer/],
      ["hop one", w => w.in.get(PAYER.toLowerCase())!.items.push(transfer(SECOND_ACCOUNT, PAYER)), /from the furnisher's account 0x2222/],
      ["hop two", w => w.in.get(FUNDER.toLowerCase())!.items.push(transfer(SECOND_ACCOUNT, FUNDER)), /account 0x2222.* through 0x5555/],
      ["first seen", w => { w.nonce = 0; w.balance = 0n; }, /first seen within the 30 days/],
      ["no other merchant", w => w.out.get(PAYER.toLowerCase())!.items.pop(), /no other merchant payment/],
    ];
    for (const [name, change, reason] of cases) {
      const w = world();
      change(w);
      const result = await screen(w, [MERCHANT, SECOND_ACCOUNT]);
      expect(result.result, name).toBe("flagged");
      expect(result.flags.join("\n"), name).toMatch(reason);
    }
  });

  it("credits a payer only with the merchant of its own charge, not the fee or another subscriber's charge", async () => {
    const w = world();
    // The payer's only other Levy payment shares a transaction with a bigger charge by someone else.
    const out = w.out.get(PAYER.toLowerCase())!.items;
    const shared = out.pop()!;
    const stranger = "0x9999999999999999999999999999999999999999" as Address;
    out.push(shared);
    w.txs.set(shared.tx, [
      { ...shared, logIndex: 1 },
      transfer(MANAGER, MERCHANT, 3, 990_000n, 2),
      transfer(MANAGER, FEE_WALLET, 3, 10_000n, 3),
      transfer(stranger, MANAGER, 3, 50_000_000n, 4),
      transfer(MANAGER, OTHER_MERCHANT, 3, 49_500_000n, 5),
    ]);
    const result = await screen(w);
    expect(result.flags).toEqual([
      "the payer made no other merchant payment in the window (a Levy charge to another merchant); payments outside Levy are not seen",
    ]);
  });

  it("is inconclusive when the explorer may be missing transfers", async () => {
    const cases: [string, (w: World) => void, RegExp][] = [
      ["not indexed", w => { w.indexed = false; }, /not finished indexing/],
      ["charge not listed", w => { w.out.get(PAYER.toLowerCase())!.items.shift(); w.out.get(PAYER.toLowerCase())!.items.push(transfer(PAYER, OTHER_MERCHANT, 2)); }, /does not list this charge/],
      ["minted", w => w.in.get(PAYER.toLowerCase())!.items.push(transfer("0x0000000000000000000000000000000000000000" as Address, PAYER)), /minted/],
    ];
    for (const [name, change, gap] of cases) {
      const w = world();
      change(w);
      const result = await screen(w);
      expect(result.result, name).toBe("inconclusive");
      expect(result.gaps.join("\n"), name).toMatch(gap);
    }
    // A charge transaction cut off at one page leaves its merchant unread, and so no "no other" flag.
    const w = world();
    const other = w.out.get(PAYER.toLowerCase())!.items[1];
    w.incompleteTxs.add(other.tx);
    w.txs.set(other.tx, [other]);
    const cut = await screen(w);
    expect(cut.result).toBe("inconclusive");
    expect(cut.flags).toEqual([]);
  });

  it("does not take a start block later than the window's start", async () => {
    const w = world();
    w.nonce = 0;
    w.balance = 0n;
    w.startBlockTime = END - 29 * DAY;
    const result = await screen(w);
    expect(result).toMatchObject({ result: "inconclusive", gaps: [READ_FAILED_GAP], read_failed: true });
  });

  it("flags one payer paying three merchants of the same furnisher", async () => {
    const w = world();
    const third = "0x3333333333333333333333333333333333333333" as Address;
    for (const m of [SECOND_ACCOUNT, third]) {
      const pay = transfer(PAYER, MANAGER, 2, 1_000_000n, 1);
      w.out.get(PAYER.toLowerCase())!.items.push(pay);
      w.txs.set(pay.tx, [pay, transfer(MANAGER, m, 2, 990_000n, 2)]);
    }
    const result = await screen(w, [MERCHANT, SECOND_ACCOUNT, third]);
    expect(result.flags).toEqual(["the payer paid 3 merchants of the same furnisher in the window"]);
  });

  it("is inconclusive, not clear, when a wallet has more transfers than it reads", async () => {
    const w = world();
    w.in.get(PAYER.toLowerCase())!.complete = false;
    const result = await screen(w);
    expect(result.result).toBe("inconclusive");
    expect(result.gaps).toEqual([
      `more than ${ENTRIES_PER_WALLET} USDC transfers reached the payer in the window; only the latest ${ENTRIES_PER_WALLET} were read`,
    ]);
    // Unread outbound history does not count as "no other merchant payment".
    const out = world();
    out.out.get(PAYER.toLowerCase())!.items.pop();
    out.out.get(PAYER.toLowerCase())!.complete = false;
    expect((await screen(out)).result).toBe("inconclusive");
  });

  it("marks a screen that could not read as inconclusive and read_failed, keeping any flag it found first", async () => {
    const failed = await screen(world(), [MERCHANT], "out");
    expect(failed.result).toBe("inconclusive");
    expect(failed.read_failed).toBe(true);
    // A fixed message, so the same outage twice stores the same result.
    expect(failed.gaps).toEqual([READ_FAILED_GAP]);

    const w = world();
    w.in.get(PAYER.toLowerCase())!.items.push(transfer(MERCHANT, PAYER));
    const flagged = await screen(w, [MERCHANT], "out");
    expect(flagged.result).toBe("flagged");
    expect(flagged.read_failed).toBe(true);
  });
});

// Answers recorded from explorer.testnet.arc.io on 2026-10-31 for the Levy fixture's paid charge.
const recorded: { responses: Record<string, unknown> } = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "fixtures", "arc-funding", "explorer.json"), "utf8")
);
const EXPLORER = "https://explorer.testnet.arc.io";

// Requests are matched whatever their address case (the recording used lowercase, the client
// checksums) and parameter order.
const keyOf = (pathAndQuery: string) => {
  const [p, q = ""] = pathAndQuery.toLowerCase().split("?");
  return `${p}?${[...new URLSearchParams(q)].sort().map(([k, v]) => `${k}=${v}`).join("&")}`;
};
function replay(responses = recorded.responses, log: string[] = []) {
  const byPath = new Map(Object.entries(responses).map(([k, v]) => [keyOf(k), v]));
  // Checked live on 2026-10-31: the explorer had finished indexing.
  if (!byPath.has(keyOf("/api/v2/main-page/indexing-status"))) {
    byPath.set(keyOf("/api/v2/main-page/indexing-status"), { finished_indexing_blocks: true });
  }
  return async (url: string) => {
    const pathAndQuery = url.slice(EXPLORER.length);
    log.push(pathAndQuery);
    const body = byPath.get(keyOf(pathAndQuery));
    return body === undefined
      ? new Response("not recorded", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  };
}

describe("explorerIndex over Arc's explorer", () => {
  const index = (fetchImpl = replay(), maxRequests?: number) =>
    explorerIndex(EXPLORER, USDC, { fetch: fetchImpl, minIntervalMs: 0, maxRequests });
  const window = { endBlock: 69_882_369n, startMs: END - 30 * DAY };

  it("reads the recorded payer's transfers, newest first, from the charge's block back", async () => {
    const inbound = await index().transfers(PAYER, "in", window, ENTRIES_PER_WALLET);
    expect(inbound.complete).toBe(true);
    expect(inbound.items).toHaveLength(1);
    expect(inbound.items[0].from.toLowerCase()).toBe("0xd218eca809484fa5675b785671583a336a9653d5");
    expect(inbound.items[0].value).toBe(3_000_000n);
    const legs = await index().transactionTransfers(
      "0xd6fbaf6ec24b0ae502b0dd4e3360619eb9052652ecbaf51ae5566d86ad6aafe5"
    );
    expect(legs.complete).toBe(true);
    expect(legs.items.map(l => l.to.toLowerCase())).toContain(MERCHANT.toLowerCase());
    expect(await index().blockAtOrBefore(END - 30 * DAY)).toBe(64_819_469n);
  });

  it("stops at the window's start, and says when a window holds more than the cap", async () => {
    const path0 = Object.keys(recorded.responses).find(k => k.includes(`${PAYER.toLowerCase()}/token-transfers`) && k.includes("filter=to"))!;
    const item = (recorded.responses[path0] as { items: Record<string, unknown>[] }).items[0];
    const many = Array.from({ length: 51 }, (_, i) => ({ ...item, log_index: 100 - i }));
    const old = { ...item, timestamp: "2026-09-01T00:00:00.000000Z" };
    const cut = await index(replay({ [path0]: { items: [item, old, item], next_page_params: { block_number: 1, index: 0 } } }))
      .transfers(PAYER, "in", window, ENTRIES_PER_WALLET);
    expect(cut).toEqual({ items: [expect.objectContaining({ value: 3_000_000n })], complete: true });
    const capped = await index(replay({ [path0]: { items: many, next_page_params: null } }))
      .transfers(PAYER, "in", window, ENTRIES_PER_WALLET);
    expect(capped.items).toHaveLength(ENTRIES_PER_WALLET);
    expect(capped.complete).toBe(false);
  });

  it("refuses a malformed or failed answer, and stops at its request budget", async () => {
    const path0 = Object.keys(recorded.responses).find(k => k.includes("filter=to") && k.includes(PAYER.toLowerCase()))!;
    await expect(index(replay({ [path0]: { items: [{ token: {} }] } })).transfers(PAYER, "in", window, 50)).rejects.toThrow(/malformed/);
    await expect(index(replay({})).transfers(PAYER, "in", window, 50)).rejects.toThrow(/answered 404/);
    const item = (recorded.responses[path0] as { items: Record<string, unknown>[] }).items[0];
    const swapped = { ...item, to: item.from };
    await expect(index(replay({ [path0]: { items: [swapped] } })).transfers(PAYER, "in", window, 50)).rejects.toThrow(/another wallet/);
    const older = { ...item, block_number: 69_000_000 };
    await expect(index(replay({ [path0]: { items: [older, item] } })).transfers(PAYER, "in", window, 50)).rejects.toThrow(/out of order/);
    const one = index(replay(), 1);
    // The cursor cannot change the filter: it is spread first.
    expect(new URLSearchParams({ ...{ filter: "from" }, ...{ filter: "to" } }).get("filter")).toBe("to");
    await one.transfers(PAYER, "in", window, 50);
    await expect(one.blockAtOrBefore(END)).rejects.toThrow(/budget/);
  });

  it("screens the recorded payer end to end", async () => {
    const result = await screenFunding({
      charge: { ...charge, tx_hash: "0xd6fbaf6ec24b0ae502b0dd4e3360619eb9052652ecbaf51ae5566d86ad6aafe5" },
      furnisherAccounts: [MERCHANT],
      levyManagers: [MANAGER],
      index: index(),
      // What Arc's RPC reported for this wallet at the window's start: no transaction, no balance.
      state: { nonceAt: async () => 0, balanceAt: async () => 0n, blockTime: async () => END - 31 * DAY },
    });
    expect(result.result).toBe("flagged");
    expect(result.flags.join("\n")).toMatch(/first seen within the 30 days/);
    expect(result.flags.join("\n")).toMatch(/no other merchant payment/);
    expect(result.gaps).toEqual([]);
    expect(result.read_failed).toBeUndefined();
    // The recorded charge's merchant really is read from its payouts: named as some other
    // merchant's charge, the recorded one counts as another merchant payment.
    const elsewhere = await screenFunding({
      charge: { ...charge, recipient: OTHER_MERCHANT, tx_hash: "0xd6fbaf6ec24b0ae502b0dd4e3360619eb9052652ecbaf51ae5566d86ad6aafe5" },
      furnisherAccounts: [],
      levyManagers: [MANAGER],
      index: index(),
      state: { nonceAt: async () => 5, balanceAt: async () => 1n, blockTime: async () => END - 31 * DAY },
    });
    expect(elsewhere.flags.join("\n")).not.toMatch(/no other merchant payment/);
  });
});
