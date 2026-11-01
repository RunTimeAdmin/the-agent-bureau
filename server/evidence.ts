// Evidence checks for furnished outcome events (Phase 0 decisions 1 and 2;
// the policy is docs/evidence-verifier.md). A passing CounterAudit proof shows
// who signed an event and that it was sealed, not that the outcome happened.
// This checks the outcome itself where a machine check exists: Levy
// subscription billing on Arc testnet. A `paid` event must match a Levy
// Charged log and the USDC transfers that settled it; a `payment_failed` event
// must match a ChargeFailed log. Any other outcome, chain, asset or subject
// form goes to a person for review.
import {
  decodeEventLog,
  formatUnits,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { EVIDENCE_STATUSES } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { rpcReader, walletState } from "./arcReader";
import {
  explorerIndex,
  screenFunding,
  type FundingScreen,
  type TransferIndex,
  type WalletState,
} from "./fundingScreen";
import { isRecord } from "./outcomeProof";
import { addMonthsUtc, RETENTION_MONTHS } from "./retention";

export const VERIFIER = "levy-arc/1";

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export type ReceiptLog = {
  address: Address;
  topics: [] | [Hex, ...Hex[]];
  data: Hex;
  logIndex: number;
};

export type Receipt = {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  logs: ReceiptLog[];
};

// The reads the check makes. server/arcReader.ts implements them over RPC.
export type ChainReader = {
  chainId(): Promise<number>;
  finalizedBlockNumber(): Promise<bigint>;
  block(number: bigint): Promise<{ hash: Hex; timestamp: bigint }>;
  receipt(hash: Hex): Promise<Receipt | null>;
  subscription(
    manager: Address,
    subId: bigint,
    blockNumber: bigint
  ): Promise<{ subscriber: Address; planId: bigint; credit: bigint }>;
  plan(
    manager: Address,
    planId: bigint,
    blockNumber: bigint
  ): Promise<{ merchant: Address; price: bigint }>;
};

export type ChainEntry = {
  chainId: number;
  rpcUrl: string;
  // A Blockscout explorer for the funding screen. Without one, paid lines are not screened.
  explorerUrl?: string;
  token: { symbol: string; address: Address; decimals: number };
  levyManagers: Address[];
};

// The chains with a verifier, keyed by the amount.chain an event names. Each
// fact below was checked against the chain on 2026-10-31.
// - USDC is Arc's gas token. Its ERC-20 interface at 0x3600...0000 has 6
//   decimals. Arc also logs a native 18-decimal copy of every USDC transfer
//   from 0xffff...fffe; only the ERC-20 log counts here.
// - Levy's SubscriptionManager deployed 2026-10-24 (Levy README,
//   Deployments). Retired deployments are not listed, so their charges go to
//   review.
// - Finality: Arc has single-block BFT finality and no reorgs (Levy
//   VERIFICATION.md section 3). A charge counts once its block is at or below
//   the RPC's finalized block and that block's hash matches the receipt's.
// Arc mainnet is not listed: Levy is not deployed there.
export const CHAINS: Record<string, ChainEntry> = {
  "arc-testnet": {
    chainId: 5042002,
    get rpcUrl() {
      return ENV.arcTestnetRpcUrl;
    },
    get explorerUrl() {
      return ENV.arcTestnetExplorerUrl;
    },
    token: {
      symbol: "USDC",
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    },
    levyManagers: ["0xea24ac9c1217a671139d93225fdcf19ea3c4df4e"],
  },
};

// The merchant accounts each furnisher has shown it controls, by chain. A Levy
// line reports the furnisher's own billing, so the plan's merchant must be one
// of these. Adding an account is a vetting step, made by pull request. None
// yet: until a furnisher is vetted for Levy, its charges go to review.
export const FURNISHER_ACCOUNTS: Record<
  string,
  { chain: string; address: Address }[]
> = {};

// occurred_at is the furnisher's claim (Phase 0 decision 7). A line fails when
// it is further than this from the block that settled it. Levy's merchant
// webhooks retry for up to about 19 hours.
export const MAX_OCCURRED_AT_SKEW_MS = 24 * 60 * 60 * 1000;

// Each charge log costs two to four RPC reads, and the furnisher picks the
// transaction. One with more charge logs than this goes to review unread.
export const MAX_CHARGE_LOGS = 20;

// What the check found on chain. amount is in token base units: what the
// payer paid for a charge, what was due for a failed one.
export type LevyCharge = {
  kind: "charged" | "charge_failed";
  chain: string;
  chain_id: number;
  tx_hash: Hex;
  log_index: number;
  block_number: string;
  block_hash: Hex;
  block_time: string;
  contract: Address;
  token: Address;
  sub_id: string;
  payer: Address;
  recipient: Address;
  amount: string;
};

export type EvidenceResult = {
  verifier: typeof VERIFIER | null;
  status: EvidenceStatus;
  // Why the line is not verified; empty when it is.
  reasons: string[];
  charge?: LevyCharge;
  // Set with charge: whether its merchant is one of the furnisher's vetted
  // accounts. Only then may the line claim the charge (see chargeKey).
  recipient_confirmed?: boolean;
  // For a charge that settled: what the funding screen found about the payer
  // (server/fundingScreen.ts). It never changes status.
  funding_screen?: FundingScreen;
};

export type EvidenceDeps = {
  chains?: Record<string, ChainEntry>;
  accounts?: typeof FURNISHER_ACCOUNTS;
  reader?: (chain: ChainEntry) => ChainReader;
  // The funding screen's reads. null skips the screen. Left out, it reads the
  // chain's explorer and RPC, except when a reader is given (a test), which
  // then skips it unless this is given too.
  screen?:
    | ((chain: ChainEntry) => { index: TransferIndex; state: WalletState } | null)
    | null;
  // The time of the check; now when left out.
  now?: () => Date;
};

function defaultScreen(chain: ChainEntry) {
  if (!chain.explorerUrl) return null;
  return {
    index: explorerIndex(chain.explorerUrl, chain.token.address),
    state: walletState(chain.rpcUrl),
  };
}

// Identifies the settlement log, so one charge cannot back two lines.
export function chargeKey(charge: LevyCharge): string {
  return `${charge.chain_id}:${charge.tx_hash.toLowerCase()}:${charge.log_index}`;
}

const LEVY_EVENTS = parseAbi([
  "event Charged(uint256 indexed subId, uint256 amount, uint256 fee, bytes32 indexed invoiceRef, uint256 chargeCount)",
  "event ChargeFailed(uint256 indexed subId, uint64 failedAttempts)",
]);
const TRANSFER = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function result(
  verifier: EvidenceResult["verifier"],
  status: EvidenceStatus,
  reasons: string[]
): EvidenceResult {
  return { verifier, status, reasons };
}

function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// A decimal string in token base units; null when it has more decimal places
// than the token.
function toUnits(value: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[2] ?? "").length > decimals) return null;
  return BigInt(match[1] + (match[2] ?? "").padEnd(decimals, "0"));
}

function subjectWallet(subjectRef: unknown): Address | null {
  if (!isRecord(subjectRef) || typeof subjectRef.wallet !== "string") {
    return null;
  }
  const wallet = subjectRef.wallet;
  return isAddress(wallet, { strict: false }) ? wallet : null;
}

function decode<const Abi extends typeof LEVY_EVENTS | typeof TRANSFER>(
  abi: Abi,
  log: ReceiptLog
) {
  try {
    return decodeEventLog({ abi, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
}

// problem fails the line. uncertain sends it to review; the amount due was
// then either charge.amount or otherAmount.
type Candidate = {
  charge: LevyCharge;
  problem: string | null;
  uncertain: string | null;
  otherAmount: bigint | null;
};

// Reads the transaction and lists the Levy charges in it of the kind the
// outcome reports. Returns a result instead when the transaction cannot back
// any line yet or at all.
async function readCharges(
  chainKey: string,
  chain: ChainEntry,
  txHash: Hex,
  kind: LevyCharge["kind"],
  reader: ChainReader
): Promise<EvidenceResult | Candidate[]> {
  const chainId = await reader.chainId();
  if (chainId !== chain.chainId) {
    return result(VERIFIER, "error", [
      `the RPC serves chain ${chainId}, not ${chain.chainId}`,
    ]);
  }
  // Arc's public RPC is load-balanced, so a node behind the others can miss a
  // mined transaction. Not found is therefore not a verdict.
  const receipt = await reader.receipt(txHash);
  if (!receipt) {
    return result(VERIFIER, "pending", [
      `transaction ${txHash} is not on ${chainKey}, or the RPC has not seen it yet`,
    ]);
  }
  const finalized = await reader.finalizedBlockNumber();
  if (receipt.blockNumber > finalized) {
    return result(VERIFIER, "pending", [
      `block ${receipt.blockNumber} is not finalized yet (finalized: ${finalized})`,
    ]);
  }
  const block = await reader.block(receipt.blockNumber);
  if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return result(VERIFIER, "error", [
      `the RPC's block ${receipt.blockNumber} differs from the receipt's`,
    ]);
  }
  if (receipt.status !== "success") {
    return result(VERIFIER, "failed", [`transaction ${txHash} reverted`]);
  }

  const logs = [...receipt.logs].sort((a, b) => a.logIndex - b.logIndex);
  const token = chain.token.address;
  // Each charge's transfers lie between it and the manager's previous charge
  // log in the same transaction.
  const previous = new Map<string, number>();
  const chargeLogs = [];
  for (const log of logs) {
    const manager = chain.levyManagers.find(m =>
      isAddressEqual(m, log.address)
    );
    const event = manager ? decode(LEVY_EVENTS, log) : null;
    if (!manager || !event) continue;
    const start = previous.get(manager) ?? -1;
    previous.set(manager, log.logIndex);
    if ((event.eventName === "Charged") === (kind === "charged")) {
      chargeLogs.push({ log, manager, event, start });
    }
  }
  if (chargeLogs.length > MAX_CHARGE_LOGS) {
    return result(VERIFIER, "needs_review", [
      `the transaction has ${chargeLogs.length} Levy charge logs of this kind, more than the ${MAX_CHARGE_LOGS} checked automatically`,
    ]);
  }

  const candidates: Candidate[] = [];
  for (const { log, manager, event, start } of chargeLogs) {
    const subId = event.args.subId;
    const sub = await reader.subscription(manager, subId, receipt.blockNumber);
    const plan = await reader.plan(manager, sub.planId, receipt.blockNumber);
    let amount: bigint;
    let problem: string | null = null;
    let uncertain: string | null = null;
    let otherAmount: bigint | null = null;
    if (event.eventName === "Charged") {
      amount = event.args.amount;
      const fee = event.args.fee;
      const transfers = logs
        .filter(
          l =>
            l.logIndex > start &&
            l.logIndex < log.logIndex &&
            isAddressEqual(l.address, token)
        )
        .map(l => decode(TRANSFER, l)?.args)
        .filter(args => args !== undefined);
      const pulled = transfers.some(
        t =>
          isAddressEqual(t.from, sub.subscriber) &&
          isAddressEqual(t.to, manager) &&
          t.value === amount
      );
      const paidOut = transfers.some(
        t =>
          isAddressEqual(t.from, manager) &&
          isAddressEqual(t.to, plan.merchant) &&
          t.value === amount - fee
      );
      if (amount === 0n) {
        problem = "the cycle was paid from proration credit, so no USDC moved";
      } else if (!pulled || !paidOut) {
        problem = `the ${chain.token.symbol} transfers in the transaction do not match its Charged log`;
      }
    } else {
      // What was due comes from state, read at the end of the block. A plan
      // change or a payment later in the same block would alter it, so the
      // state before the block is read too and a difference goes to review.
      // (The merchant cannot differ: Levy's changePlan keeps it.)
      const due = (s: typeof sub, p: typeof plan) =>
        p.price > s.credit ? p.price - s.credit : 0n;
      amount = due(sub, plan);
      const before = receipt.blockNumber - 1n;
      const subBefore = await reader.subscription(manager, subId, before);
      const planBefore = await reader.plan(manager, subBefore.planId, before);
      const amountBefore = due(subBefore, planBefore);
      if (amountBefore !== amount) {
        otherAmount = amountBefore;
        uncertain = `the subscription changed within block ${receipt.blockNumber}, so the amount due was ${formatUnits(amountBefore, chain.token.decimals)} or ${formatUnits(amount, chain.token.decimals)} ${chain.token.symbol}`;
      }
    }
    candidates.push({
      charge: {
        kind,
        chain: chainKey,
        chain_id: chain.chainId,
        tx_hash: txHash,
        log_index: log.logIndex,
        block_number: receipt.blockNumber.toString(),
        block_hash: receipt.blockHash,
        block_time: new Date(Number(block.timestamp) * 1000).toISOString(),
        contract: manager,
        token,
        sub_id: subId.toString(),
        payer: sub.subscriber,
        recipient: plan.merchant,
        amount: amount.toString(),
      },
      problem,
      uncertain,
      otherAmount,
    });
  }
  return candidates;
}

/**
 * Checks a signed outcome event's evidence. Never throws: a failed chain read
 * comes back as status "error". Makes read calls only.
 */
export async function verifyEvidence(
  event: Record<string, unknown>,
  deps: EvidenceDeps = {}
): Promise<EvidenceResult> {
  const { outcome, amount, evidence } = event;
  if (outcome !== "paid" && outcome !== "payment_failed") {
    return result(null, "needs_review", [
      `no machine check exists for ${String(outcome)} outcomes`,
    ]);
  }
  if (
    !isRecord(amount) ||
    typeof amount.value !== "string" ||
    typeof amount.asset !== "string" ||
    typeof amount.chain !== "string"
  ) {
    return result(null, "failed", [
      `a ${outcome} outcome needs amount.value, amount.asset and amount.chain`,
    ]);
  }
  const chains = deps.chains ?? CHAINS;
  const chainKey = amount.chain;
  const chain = lookup(chains, chainKey);
  if (!chain) {
    return result(null, "needs_review", [
      `no verifier for chain ${chainKey}; checked chains: ${Object.keys(chains).join(", ")}`,
    ]);
  }
  const { symbol, decimals } = chain.token;
  if (amount.asset !== symbol) {
    return result(null, "needs_review", [
      `no verifier for ${amount.asset} on ${chainKey}, only ${symbol}`,
    ]);
  }
  const txHash = isRecord(evidence) ? evidence.tx_hash : undefined;
  if (txHash === undefined) {
    return result(null, "needs_review", [
      "the evidence names no transaction (evidence.tx_hash)",
    ]);
  }
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return result(VERIFIER, "failed", [
      "evidence.tx_hash is not a 0x-prefixed 32-byte transaction hash",
    ]);
  }
  const units = toUnits(amount.value, decimals);
  if (units === null) {
    return result(VERIFIER, "failed", [
      `amount ${amount.value} has more than ${decimals} decimal places`,
    ]);
  }

  const kind = outcome === "paid" ? "charged" : "charge_failed";
  let found: EvidenceResult | Candidate[];
  try {
    const reader = (deps.reader ?? (c => rpcReader(c.rpcUrl)))(chain);
    found = await readCharges(chainKey, chain, txHash as Hex, kind, reader);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return result(VERIFIER, "error", [
      `chain read failed: ${message.split("\n")[0]}`,
    ]);
  }
  if (!Array.isArray(found)) return found;

  const logName = kind === "charged" ? "Charged" : "ChargeFailed";
  if (found.length === 0) {
    return result(VERIFIER, "failed", [
      `the transaction has no Levy ${logName} log`,
    ]);
  }
  const wallet = subjectWallet(event.subject_ref);
  const matches = found.filter(
    c =>
      (BigInt(c.charge.amount) === units || c.otherAmount === units) &&
      (!wallet || isAddressEqual(c.charge.payer, wallet))
  );
  if (matches.length === 0) {
    const seen = found
      .map(
        c =>
          `${c.charge.payer} ${formatUnits(BigInt(c.charge.amount), decimals)} ${symbol}`
      )
      .join("; ");
    return result(VERIFIER, "failed", [
      `no ${logName} log matches ${wallet ?? "the subject"} and ${amount.value} ${symbol}; found ${seen}`,
    ]);
  }
  if (matches.length > 1) {
    return result(VERIFIER, "needs_review", [
      `${matches.length} ${logName} logs in the transaction match the event`,
    ]);
  }
  const [{ charge, problem, uncertain }] = matches;

  const failures: string[] = problem ? [problem] : [];
  const reviews: string[] = uncertain ? [uncertain] : [];
  if (!wallet) {
    reviews.push(
      "the subject is not an EVM wallet; matching a registry id or DID to the payer is not built (Phase 0 decision 3)"
    );
  }
  const furnisherId = String(event.furnisher_id);
  const accounts = (
    lookup(deps.accounts ?? FURNISHER_ACCOUNTS, furnisherId) ?? []
  ).filter(account => account.chain === chainKey);
  const recipientConfirmed = accounts.some(a =>
    isAddressEqual(a.address, charge.recipient)
  );
  if (accounts.length === 0) {
    reviews.push(
      `${furnisherId} has no vetted merchant account on ${chainKey}, so the recipient ${charge.recipient} is not confirmed as theirs`
    );
  } else if (!recipientConfirmed) {
    failures.push(
      `the charge's merchant ${charge.recipient} is not an account of ${furnisherId}`
    );
  }
  if (
    isAddressEqual(charge.payer, charge.recipient) ||
    accounts.some(a => isAddressEqual(a.address, charge.payer))
  ) {
    reviews.push(
      "the payer is the merchant or another of the furnisher's own accounts, so the charge is not with another party"
    );
  }
  const skew = Math.abs(
    Date.parse(String(event.occurred_at)) - Date.parse(charge.block_time)
  );
  if (!(skew <= MAX_OCCURRED_AT_SKEW_MS)) {
    failures.push(
      `occurred_at is more than 24 hours from the block's time, ${charge.block_time}`
    );
  }
  // Older than the retention baseline, a charge backs no line: one it backed
  // before may have expired, and pnpm lines expire erased that line's claim on
  // it, which is what kept one charge from backing two lines.
  const now = (deps.now ?? (() => new Date()))();
  if (
    addMonthsUtc(new Date(charge.block_time), RETENTION_MONTHS).getTime() <=
    now.getTime()
  ) {
    failures.push(
      `the charge settled at ${charge.block_time}, more than ${RETENTION_MONTHS} months ago, past the retention baseline`
    );
  }
  const status = failures.length
    ? "failed"
    : reviews.length
      ? "needs_review"
      : "verified";
  // A settled charge is screened for a payer related to the furnisher. A
  // failed line is not: nothing it shows can be released.
  let fundingScreen: FundingScreen | undefined;
  const screen =
    deps.screen !== undefined ? deps.screen : deps.reader ? null : defaultScreen;
  const reads = status !== "failed" && charge.kind === "charged" && screen ? screen(chain) : null;
  if (reads) {
    fundingScreen = await screenFunding({
      charge,
      furnisherAccounts: accounts.map(a => a.address),
      levyManagers: chain.levyManagers,
      ...reads,
    });
  }
  return {
    verifier: VERIFIER,
    status,
    reasons: [...failures, ...reviews],
    charge,
    recipient_confirmed: recipientConfirmed,
    ...(fundingScreen ? { funding_screen: fundingScreen } : {}),
  };
}
