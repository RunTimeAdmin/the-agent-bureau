// The chain reads the evidence check needs, over JSON-RPC with viem. Read
// calls only: no account, no signer, no transaction.
import {
  createPublicClient,
  http,
  parseAbi,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import type { ChainReader } from "./evidence";
import type { WalletState } from "./fundingScreen";

const LEVY_READS = parseAbi([
  "function subscriptions(uint256) view returns (address subscriber, uint256 planId, uint64 start, uint64 nextChargeAt, uint64 failedAttempts, uint256 credit, uint256 chargeCount, uint8 status)",
  "function plans(uint256) view returns (address merchant, uint256 price, uint256 cycleSeconds, uint256 trialSeconds, uint256 graceSeconds, uint8 maxFailed, bool exists)",
]);

/** A wallet's nonce and balance at a past block, for the funding screen. Needs a node that keeps old state, as Arc's public RPC does. */
export function walletState(rpcUrl: string): WalletState {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }),
  });
  return {
    nonceAt: (address, blockNumber) => client.getTransactionCount({ address, blockNumber }),
    balanceAt: (address, blockNumber) => client.getBalance({ address, blockNumber }),
    async blockTime(blockNumber) {
      return Number((await client.getBlock({ blockNumber })).timestamp) * 1000;
    },
  };
}

export function rpcReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }),
  });
  return {
    chainId: () => client.getChainId(),
    async finalizedBlockNumber() {
      return (await client.getBlock({ blockTag: "finalized" })).number;
    },
    async block(number: bigint) {
      const block = await client.getBlock({ blockNumber: number });
      return { hash: block.hash, timestamp: block.timestamp };
    },
    async receipt(hash: Hex) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          logs: receipt.logs.map(log => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
            logIndex: log.logIndex,
          })),
        };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    async subscription(manager: Address, subId: bigint, blockNumber: bigint) {
      const [subscriber, planId, , , , credit] = await client.readContract({
        address: manager,
        abi: LEVY_READS,
        functionName: "subscriptions",
        args: [subId],
        blockNumber,
      });
      return { subscriber, planId, credit };
    },
    async plan(manager: Address, planId: bigint, blockNumber: bigint) {
      const [merchant, price] = await client.readContract({
        address: manager,
        abi: LEVY_READS,
        functionName: "plans",
        args: [planId],
        blockNumber,
      });
      return { merchant, price };
    },
  };
}
