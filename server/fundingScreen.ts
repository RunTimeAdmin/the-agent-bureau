// The funding screen for a paid line (review finding M-04, docs/independent-payer.md, decided
// 2026-10-31). A settled Levy charge proves money moved from the payer wallet to the furnisher's
// merchant, not that the payer is someone other than the furnisher. This looks at where the
// payer's USDC came from and whom else it pays, and flags what suggests the two are related. It
// reaches no verdict: a flag, or a result it could not complete, sends the line to a person, and
// nothing here fails a line.
//
// Arc's public RPC answers eth_getLogs over at most a few thousand blocks and limits its rate, and
// 30 days on Arc is about five million blocks, so the transfers come from Arc's own explorer
// (Blockscout), which indexes them per address. The explorer is a third party's index of the
// chain, not the chain: what it leaves out, the screen does not see, which is one more reason a
// clear result proves nothing. The wallet's state at the window's start comes from the RPC.
import { isAddress, isAddressEqual, type Address, type Hex } from "viem";
import type { LevyCharge } from "./evidence";

export const SCREEN = "arc-funding/1";
// The limits decided on 2026-10-31.
export const WINDOW_DAYS = 30;
export const ENTRIES_PER_WALLET = 50;
export const LINKED_MERCHANTS_FLAG = 3;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const ZERO = "0x0000000000000000000000000000000000000000";
// Fixed, so a screen that failed for the same reason twice stores the same result, and the
// evidence digest reviewers signed does not change with the error's wording.
export const READ_FAILED_GAP = "the screen could not finish reading the explorer or the RPC";

export type ScreenResult = "clear" | "flagged" | "inconclusive";

export type FundingScreen = {
  screen: typeof SCREEN;
  result: ScreenResult;
  // What suggests the payer is related to the furnisher. Any one makes the result flagged.
  flags: string[];
  // What the screen could not see. With no flag, any one makes the result inconclusive.
  gaps: string[];
  window_start: string;
  window_end: string;
  // Set when a read failed, so an intake re-run keeps an earlier complete result instead.
  read_failed?: true;
};

export type Transfer = {
  from: Address;
  to: Address;
  value: bigint;
  block: bigint;
  time: number;
  tx: Hex;
  logIndex: number;
};

export type TransferIndex = {
  /** Whether the explorer has indexed every block, so a transfer missing from it did not happen. */
  indexingFinished(): Promise<boolean>;
  /**
   * USDC transfers into (`in`) or out of (`out`) a wallet, newest first, in blocks up to and
   * including `endBlock` and no older than `startMs`. At most `limit`; `complete` is false when
   * the window holds more than that.
   */
  transfers(
    wallet: Address,
    direction: "in" | "out",
    window: { endBlock: bigint; startMs: number },
    limit: number
  ): Promise<{ items: Transfer[]; complete: boolean }>;
  /** The USDC transfers in one transaction; `complete` is false when there were more than one page. */
  transactionTransfers(tx: Hex): Promise<{ items: Transfer[]; complete: boolean }>;
  /** The last block at or before a time. */
  blockAtOrBefore(ms: number): Promise<bigint>;
};

export type WalletState = {
  nonceAt(wallet: Address, block: bigint): Promise<number>;
  balanceAt(wallet: Address, block: bigint): Promise<bigint>;
  /** A block's time, in milliseconds. */
  blockTime(block: bigint): Promise<number>;
};

export type ScreenInput = {
  charge: LevyCharge;
  // The furnisher's vetted accounts on the charge's chain.
  furnisherAccounts: Address[];
  levyManagers: Address[];
  index: TransferIndex;
  state: WalletState;
};

const lower = (a: string) => a.toLowerCase();

/**
 * The merchant of each charge the payer made in a transaction. A Levy charge pulls from the
 * subscriber into the contract, then pays most of it to the merchant and a small fee to Levy. A
 * transaction can carry other subscribers' charges, so each payout is paired with the pull it
 * follows: the payouts after the payer's pull and before the next pull into Levy, and of those the
 * largest is the merchant's.
 */
function chargedMerchants(legs: Transfer[], payer: Address, levy: Set<string>): Address[] {
  const ordered = [...legs].sort((a, b) => a.logIndex - b.logIndex);
  const merchants: Address[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const pull = ordered[i];
    if (!isAddressEqual(pull.from, payer) || !levy.has(lower(pull.to))) continue;
    let largest: Transfer | null = null;
    for (const leg of ordered.slice(i + 1)) {
      if (levy.has(lower(leg.to))) break;
      if (isAddressEqual(leg.from, pull.to) && (!largest || leg.value > largest.value)) largest = leg;
    }
    if (largest) merchants.push(largest.to);
  }
  return merchants;
}

export async function screenFunding(input: ScreenInput): Promise<FundingScreen> {
  const { charge, index, state } = input;
  const payer = charge.payer;
  const merchant = charge.recipient;
  const endBlock = BigInt(charge.block_number);
  const endMs = Date.parse(charge.block_time);
  const startMs = endMs - WINDOW_MS;
  const window = { endBlock, startMs };
  // The merchant is the furnisher's, whether or not it is vetted yet.
  const related = new Set([merchant, ...input.furnisherAccounts].map(lower));
  const levy = new Set(input.levyManagers.map(lower));
  const flags: string[] = [];
  const gaps: string[] = [];
  let readFailed = false;

  try {
    if (!(await index.indexingFinished())) {
      gaps.push("the explorer has not finished indexing the chain, so transfers may be missing from it");
    }

    // Hop one: who paid the payer.
    const inbound = await index.transfers(payer, "in", window, ENTRIES_PER_WALLET);
    if (!inbound.complete) {
      gaps.push(`more than ${ENTRIES_PER_WALLET} USDC transfers reached the payer in the window; only the latest ${ENTRIES_PER_WALLET} were read`);
    }
    const sources = new Map<string, Address>();
    let minted = false;
    for (const t of inbound.items) {
      if (isAddressEqual(t.from, merchant)) {
        flags.push(`the merchant ${merchant} also paid the payer (tx ${t.tx}), so they transfer to each other`);
      } else if (related.has(lower(t.from))) {
        flags.push(`USDC reached the payer from the furnisher's account ${t.from} (tx ${t.tx})`);
      } else if (isAddressEqual(t.from, ZERO)) {
        minted = true;
      } else if (!isAddressEqual(t.from, payer)) {
        sources.set(lower(t.from), t.from);
      }
    }
    // Hop two: who paid those.
    for (const source of sources.values()) {
      const second = await index.transfers(source, "in", window, ENTRIES_PER_WALLET);
      if (!second.complete) {
        gaps.push(`more than ${ENTRIES_PER_WALLET} USDC transfers reached ${source}, which paid the payer; only the latest ${ENTRIES_PER_WALLET} were read`);
      }
      for (const t of second.items) {
        if (related.has(lower(t.from))) {
          flags.push(`USDC reached the payer from the furnisher's account ${t.from} through ${source} (tx ${t.tx})`);
        } else if (isAddressEqual(t.from, ZERO)) {
          minted = true;
        }
      }
    }
    // Minted USDC arrived from outside the chain (bridged in, say), and its source is not traced.
    if (minted) gaps.push("USDC minted on this chain reached the payer within two hops, and where it came from is not traced");

    // First seen: no transaction sent and nothing held when the window opened. A wallet cannot
    // move funds out without sending a transaction, so one that had neither was not in use. The
    // block comes from the explorer and is checked against the RPC: one later than the window's
    // start would hide a wallet that is new.
    const startBlock = await index.blockAtOrBefore(startMs);
    if (startBlock >= endBlock || (await state.blockTime(startBlock)) > startMs) {
      throw new Error("the explorer named a block after the window's start");
    }
    const [nonce, balance] = await Promise.all([
      state.nonceAt(payer, startBlock),
      state.balanceAt(payer, startBlock),
    ]);
    if (nonce === 0 && balance === 0n) {
      flags.push(`the payer wallet was first seen within the ${WINDOW_DAYS} days before the charge: no transaction and no balance at block ${startBlock}`);
    }

    // Merchant payments: the payer's Levy charges in the window. A payment outside Levy is not
    // recognised as one.
    const outbound = await index.transfers(payer, "out", window, ENTRIES_PER_WALLET);
    if (!outbound.complete) {
      gaps.push(`more than ${ENTRIES_PER_WALLET} USDC transfers left the payer in the window; only the latest ${ENTRIES_PER_WALLET} were read`);
    }
    // This charge is in the window, so an explorer that does not list it has not caught up.
    if (!outbound.items.some(t => lower(t.tx) === lower(charge.tx_hash))) {
      gaps.push("the explorer does not list this charge's transfer, so it may not have indexed the window");
    }
    const chargeTxs = new Set(outbound.items.filter(t => levy.has(lower(t.to))).map(t => t.tx));
    const merchants = new Map<string, Address>();
    let unread = false;
    for (const tx of chargeTxs) {
      const legs = await index.transactionTransfers(tx);
      if (!legs.complete) unread = true;
      for (const m of chargedMerchants(legs.items, payer, levy)) merchants.set(lower(m), m);
    }
    if (unread) gaps.push("a charge transaction of the payer's had more transfers than the explorer returned, so its merchant may not have been read");
    const others = [...merchants.values()].filter(m => !isAddressEqual(m, merchant));
    // With part of the outbound history unread, "no other" would only describe what was read.
    if (others.length === 0 && outbound.complete && !unread) {
      flags.push(`the payer made no other merchant payment in the window (a Levy charge to another merchant); payments outside Levy are not seen`);
    }
    const linked = [...merchants.values()].filter(m => related.has(lower(m)));
    if (linked.length >= LINKED_MERCHANTS_FLAG) {
      flags.push(`the payer paid ${linked.length} merchants of the same furnisher in the window`);
    }
  } catch {
    readFailed = true;
    gaps.push(READ_FAILED_GAP);
  }

  return {
    screen: SCREEN,
    result: flags.length ? "flagged" : gaps.length ? "inconclusive" : "clear",
    flags,
    gaps,
    window_start: new Date(startMs).toISOString(),
    window_end: new Date(endMs).toISOString(),
    ...(readFailed ? { read_failed: true as const } : {}),
  };
}

// ---- Arc's explorer (Blockscout API v2) ---------------------------------------------------------

// The explorer allows 180 requests in its window; one screen reads at most this many, spaced out,
// and gives up after the deadline.
const MAX_REQUESTS_PER_SCREEN = 200;
const MIN_INTERVAL_MS = 350;
const SCREEN_DEADLINE_MS = 3 * 60 * 1000;
const MAX_PAGES = 4;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A TransferIndex over a Blockscout explorer, counting only the given token's transfers. On Arc
 * the explorer lists each USDC movement once under the ERC-20 address, whichever interface made it
 * (a plain native send included), so nothing is counted twice. Each call makes a fresh budget and
 * deadline, so make one per screen.
 */
export function explorerIndex(
  baseUrl: string,
  token: Address,
  options: { fetch?: Fetch; minIntervalMs?: number; maxRequests?: number; deadlineMs?: number } = {}
): TransferIndex {
  const doFetch = options.fetch ?? fetch;
  const minInterval = options.minIntervalMs ?? MIN_INTERVAL_MS;
  const deadline = Date.now() + (options.deadlineMs ?? SCREEN_DEADLINE_MS);
  let remaining = options.maxRequests ?? MAX_REQUESTS_PER_SCREEN;
  let last = 0;

  async function get(path: string): Promise<unknown> {
    if (remaining <= 0) throw new Error("the explorer read budget for one screen is spent");
    if (Date.now() > deadline) throw new Error("the screen ran past its deadline");
    remaining--;
    const wait = last + minInterval - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    last = Date.now();
    const res = await doFetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`the explorer answered ${res.status}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("the explorer's answer is too large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const hashOf = (v: unknown): string => (isObject(v) && typeof v.hash === "string" ? v.hash : "");

  // A transfer of the token, or null for another token's. Anything malformed throws, so a screen
  // never reads a partial answer as a complete one. The explorer gives a transaction's transfers
  // no timestamp, and those are read only for who paid whom, so `timed` is false for them.
  function parse(item: unknown, timed = true): Transfer | null {
    if (!isObject(item) || !isObject(item.token) || !isObject(item.total)) throw new Error("the explorer sent a malformed transfer");
    if (typeof item.token.address_hash !== "string" || !isAddress(item.token.address_hash, { strict: false })) {
      throw new Error("the explorer sent a malformed transfer");
    }
    if (!isAddressEqual(item.token.address_hash, token)) return null;
    const from = hashOf(item.from);
    const to = hashOf(item.to);
    const value = item.total.value;
    const time = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : NaN;
    if (
      !isAddress(from, { strict: false }) || !isAddress(to, { strict: false }) ||
      typeof value !== "string" || !/^\d+$/.test(value) ||
      typeof item.block_number !== "number" || (timed && !Number.isFinite(time)) ||
      typeof item.transaction_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(item.transaction_hash) ||
      typeof item.log_index !== "number"
    ) {
      throw new Error("the explorer sent a malformed transfer");
    }
    return {
      from: from as Address,
      to: to as Address,
      value: BigInt(value),
      block: BigInt(item.block_number),
      time,
      tx: item.transaction_hash as Hex,
      logIndex: item.log_index,
    };
  }

  return {
    async indexingFinished() {
      const body = await get("/api/v2/main-page/indexing-status");
      return isObject(body) && body.finished_indexing_blocks === true;
    },
    async transfers(wallet, direction, window, limit) {
      const base = { type: "ERC-20", filter: direction === "in" ? "to" : "from", token };
      // Blockscout pages by (block, log index), newest first; starting just past endBlock leaves
      // out everything after the charge. The filter is spread last, so a cursor cannot change it.
      let cursor: Record<string, string> = { block_number: String(window.endBlock + 1n), index: "0" };
      const items: Transfer[] = [];
      let previous: Transfer | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await get(`/api/v2/addresses/${wallet}/token-transfers?${new URLSearchParams({ ...cursor, ...base })}`);
        if (!isObject(body) || !Array.isArray(body.items)) throw new Error("the explorer sent no transfer list");
        for (const raw of body.items) {
          const t = parse(raw);
          if (!t) continue;
          // An answer for another wallet or direction, or out of order, would end a read early.
          if (!isAddressEqual(direction === "in" ? t.to : t.from, wallet)) throw new Error("the explorer sent another wallet's transfer");
          if (t.block > window.endBlock) throw new Error("the explorer sent a transfer past the cursor");
          if (previous && (t.block > previous.block || (t.block === previous.block && t.logIndex > previous.logIndex))) {
            throw new Error("the explorer sent transfers out of order");
          }
          previous = t;
          if (t.time < window.startMs) return { items, complete: true };
          if (items.length === limit) return { items, complete: false };
          items.push(t);
        }
        const next = body.next_page_params;
        if (!isObject(next)) return { items, complete: true };
        cursor = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)]));
      }
      return { items, complete: false };
    },
    async transactionTransfers(tx) {
      const body = await get(`/api/v2/transactions/${tx}/token-transfers?${new URLSearchParams({ type: "ERC-20" })}`);
      if (!isObject(body) || !Array.isArray(body.items)) throw new Error("the explorer sent no transfer list");
      const items = body.items.map(item => parse(item, false)).filter((t): t is Transfer => t !== null);
      return { items, complete: !isObject(body.next_page_params) };
    },
    async blockAtOrBefore(ms) {
      const body = await get(`/api?${new URLSearchParams({ module: "block", action: "getblocknobytime", timestamp: String(Math.floor(ms / 1000)), closest: "before" })}`);
      const block = isObject(body) && isObject(body.result) ? body.result.blockNumber : undefined;
      if (typeof block !== "string" || !/^\d+$/.test(block)) throw new Error("the explorer did not name a block for the window's start");
      return BigInt(block);
    },
  };
}
