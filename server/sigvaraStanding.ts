// Sigvara's standing for an agent, as a third-party fact on its file
// (docs/agent-file.md; bureau-spec.md, "Third-party standing"). Read from
// Sigvara's contracts at one finalized block, which the file names, so a reader
// can read the same block and compare. Read calls only: no account, no signer.
import {
  createPublicClient,
  encodePacked,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { isRecord, type CheckResult } from "./outcomeProof";

// Sigvara's deployment on Arc testnet (RunTimeAdmin/Sigvara,
// deployments/5042002.json). Pinned by pull request: a file states what these
// contracts said, so they are not taken from the environment.
export const SIGVARA_ARC_TESTNET = {
  chainId: 5042002,
  network: "Arc testnet (chain 5042002)",
  identity: "0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd",
  reputation: "0x6603C96275e85F724Cdf74666b399365e4cA29ed",
  staking: "0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B",
} as const;

export const STANDING_LABEL =
  "A third-party fact read from Sigvara's contracts at the block named here. Sigvara computes this score; it is not the Bureau's verdict.";

// How long before a file's issue time the block it names may be: the read and
// the signing happen in one run, and a finalized block trails the head by
// seconds on Arc. An older block would let a file show a past standing.
const MAX_BLOCK_AGE_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;

// SigvaraIdentity.AgentStatus, in order.
const STATUSES = ["Active", "Suspended", "Slashed", "PendingBond"] as const;

const READS = parseAbi([
  "struct AgentIdentity { address operator; address agentAddress; bytes32 ed25519PubKey; uint8 status; uint256 registeredAt; }",
  "struct ReputationData { uint8 feeScore; uint8 successScore; uint8 ageScore; uint8 externalScore; uint8 communityScore; uint8 propagationScore; uint256 lastUpdated; }",
  "function getIdentity(bytes32 didHash) view returns (AgentIdentity)",
  "function getReputation(bytes32 didHash) view returns (ReputationData)",
  "function getTotalScore(bytes32 didHash) view returns (uint8)",
  "function getStake(bytes32 didHash) view returns (uint256)",
  "function hasMinimumStake(bytes32 didHash) view returns (bool)",
]);

export type SigvaraStanding = {
  source: "Sigvara";
  network: string;
  label: string;
  did_hash: Hex;
  read_at: {
    block_number: string;
    block_hash: Hex;
    block_time: string;
    finality: "finalized";
  };
  contracts: { identity: string; reputation: string; staking: string };
  status: (typeof STATUSES)[number] | "not_registered";
  registered_at: string | null;
  /**
   * At the block named: `total` is what SigvaraReputation's getTotalScore gives,
   * the matured score, which can trail the factors after a rise and restarts
   * after an operator handover. The factors are the last finalized proposal.
   */
  score: {
    total: number;
    fee: number;
    success: number;
    age: number;
    external: number;
    community: number;
    propagation: number;
    last_updated: string | null;
  } | null;
  /** In the stake token's smallest unit, as a decimal string. */
  stake: string | null;
  has_minimum_stake: boolean | null;
};

// The chain id written plainly (no leading zero) and an EVM address in any case:
// the address compares without case, as subjectKey in lineState.ts does.
const DID = /^did:sigvara:(0|[1-9][0-9]{0,11}):(0x[0-9a-fA-F]{40})$/;

/** The chain and agent address a did:sigvara subject names, or null for any other subject. */
export function parseSigvaraDid(
  subjectRef: Record<string, unknown>
): { chainId: number; address: Address } | null {
  const did = subjectRef.did;
  if (Object.keys(subjectRef).length !== 1 || typeof did !== "string")
    return null;
  const m = DID.exec(did);
  return m
    ? { chainId: Number(m[1]), address: m[2].toLowerCase() as Address }
    : null;
}

/**
 * Sigvara's didHash: keccak256(abi.encodePacked("did:sigvara:", chainid, ":",
 * agentAddress)), as SigvaraIdentity computes it. The address is packed as 20
 * bytes, so its case does not change the hash.
 */
export function sigvaraDidHash(chainId: number, address: Address): Hex {
  return keccak256(
    encodePacked(
      ["string", "uint256", "string", "address"],
      ["did:sigvara:", BigInt(chainId), ":", address.toLowerCase() as Address]
    )
  );
}

export type SigvaraBlock = { number: bigint; hash: Hex; timestamp: bigint };

/** What reading a standing needs, so a test can stand in for the chain. */
export type SigvaraClient = {
  chainId(): Promise<number>;
  finalizedBlock(): Promise<SigvaraBlock>;
  block(number: bigint): Promise<SigvaraBlock>;
  identity(
    didHash: Hex,
    at: bigint
  ): Promise<{ agentAddress: Address; status: number; registeredAt: bigint }>;
  reputation(
    didHash: Hex,
    at: bigint
  ): Promise<{
    feeScore: number;
    successScore: number;
    ageScore: number;
    externalScore: number;
    communityScore: number;
    propagationScore: number;
    lastUpdated: bigint;
  }>;
  totalScore(didHash: Hex, at: bigint): Promise<number>;
  stake(didHash: Hex, at: bigint): Promise<bigint>;
  hasMinimumStake(didHash: Hex, at: bigint): Promise<boolean>;
};

const isoSeconds = (s: bigint) => new Date(Number(s) * 1000).toISOString();

/**
 * The agent's standing on Sigvara at `block`, or at the latest finalized block,
 * or null when the subject is not a did:sigvara agent on the pinned chain.
 * Throws when the chain cannot be read, or reads as another chain or agent.
 */
export async function readSigvaraStanding(
  subjectRef: Record<string, unknown>,
  client: SigvaraClient,
  block?: bigint
): Promise<SigvaraStanding | null> {
  const parsed = parseSigvaraDid(subjectRef);
  if (!parsed || parsed.chainId !== SIGVARA_ARC_TESTNET.chainId) return null;
  const chainId = await client.chainId();
  if (chainId !== SIGVARA_ARC_TESTNET.chainId) {
    throw new Error(
      `the Arc RPC serves chain ${chainId}, not ${SIGVARA_ARC_TESTNET.chainId}`
    );
  }
  const at =
    block === undefined
      ? await client.finalizedBlock()
      : await client.block(block);
  const didHash = sigvaraDidHash(parsed.chainId, parsed.address);
  const id = await client.identity(didHash, at.number);
  const base = {
    source: "Sigvara" as const,
    network: SIGVARA_ARC_TESTNET.network,
    label: STANDING_LABEL,
    did_hash: didHash,
    read_at: {
      block_number: at.number.toString(),
      block_hash: at.hash,
      block_time: isoSeconds(at.timestamp),
      finality: "finalized" as const,
    },
    contracts: {
      identity: SIGVARA_ARC_TESTNET.identity,
      reputation: SIGVARA_ARC_TESTNET.reputation,
      staking: SIGVARA_ARC_TESTNET.staking,
    },
  };
  if (id.registeredAt === 0n) {
    return {
      ...base,
      status: "not_registered",
      registered_at: null,
      score: null,
      stake: null,
      has_minimum_stake: null,
    };
  }
  if (id.agentAddress.toLowerCase() !== parsed.address) {
    throw new Error(
      `Sigvara's identity for ${didHash} names agent ${id.agentAddress}, not ${parsed.address}`
    );
  }
  const status = STATUSES[id.status];
  if (!status)
    throw new Error(`Sigvara reports an unknown status ${id.status}`);
  const [rep, total, stake, minimum] = await Promise.all([
    client.reputation(didHash, at.number),
    client.totalScore(didHash, at.number),
    client.stake(didHash, at.number),
    client.hasMinimumStake(didHash, at.number),
  ]);
  return {
    ...base,
    status,
    registered_at: isoSeconds(id.registeredAt),
    score: {
      total,
      fee: rep.feeScore,
      success: rep.successScore,
      age: rep.ageScore,
      external: rep.externalScore,
      community: rep.communityScore,
      propagation: rep.propagationScore,
      last_updated: rep.lastUpdated === 0n ? null : isoSeconds(rep.lastUpdated),
    },
    stake: stake.toString(),
    has_minimum_stake: minimum,
  };
}

/**
 * Whether a standing on a file is exactly what this code reads from Sigvara's
 * contracts at the block it names, wording and fields included, and whether
 * that block was finalized and read when the file was issued (`issuedAt`), not
 * long before. It trusts the RPC it is given: a reader who wants an independent
 * check points ARC_TESTNET_RPC_URL at a node of their own.
 */
export async function checkSigvaraStanding(
  subjectRef: unknown,
  entry: unknown,
  client: SigvaraClient,
  issuedAt: string
): Promise<CheckResult> {
  try {
    if (!isRecord(subjectRef) || !isRecord(entry) || !isRecord(entry.read_at)) {
      return { ok: false, detail: "not a Sigvara standing" };
    }
    const number = entry.read_at.block_number;
    if (typeof number !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(number)) {
      return { ok: false, detail: "no block number" };
    }
    const fresh = await readSigvaraStanding(subjectRef, client, BigInt(number));
    if (!fresh)
      return {
        ok: false,
        detail: "the subject is not a did:sigvara agent on Arc testnet",
      };
    if (JSON.stringify(canonical(fresh)) !== JSON.stringify(canonical(entry))) {
      return {
        ok: false,
        detail: `Sigvara's contracts say otherwise at block ${number}, or the entry has fields they do not give`,
      };
    }
    const head = await client.finalizedBlock();
    if (BigInt(number) > head.number) {
      return { ok: false, detail: `block ${number} is not finalized yet` };
    }
    const blockTime = Date.parse(fresh.read_at.block_time);
    const issued = Date.parse(issuedAt);
    if (
      !Number.isFinite(issued) ||
      blockTime > issued + CLOCK_SKEW_MS ||
      blockTime < issued - MAX_BLOCK_AGE_MS
    ) {
      return {
        ok: false,
        detail: `block ${number} (${fresh.read_at.block_time}) is not one read when the file was issued`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Keys sorted at every level, so two readings compare by content.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(k => [k, canonical(value[k])])
    );
  }
  return value;
}

// viem's error messages carry the RPC URL, which can hold a key; its short
// message does not.
async function quietly<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const short = (error as { shortMessage?: unknown } | null)?.shortMessage;
    throw new Error(
      `the Arc RPC could not ${what}${typeof short === "string" ? `: ${short}` : ""}`
    );
  }
}

/** Sigvara's contracts over JSON-RPC, read at a given block. */
export function rpcSigvaraClient(rpcUrl: string): SigvaraClient {
  const client = createPublicClient({
    transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }),
  });
  const read = <T>(
    address: string,
    functionName:
      | "getIdentity"
      | "getReputation"
      | "getTotalScore"
      | "getStake"
      | "hasMinimumStake",
    didHash: Hex,
    at: bigint
  ) =>
    quietly(
      `read ${functionName}`,
      () =>
        client.readContract({
          address: address as Address,
          abi: READS,
          functionName,
          args: [didHash],
          blockNumber: at,
        }) as Promise<T>
    );
  const toBlock = (b: {
    number: bigint | null;
    hash: Hex | null;
    timestamp: bigint;
  }): SigvaraBlock => {
    if (b.number === null || b.hash === null)
      throw new Error("the block is not final");
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  };
  return {
    chainId: () => quietly("read its chain id", () => client.getChainId()),
    finalizedBlock: async () =>
      toBlock(
        await quietly("read the finalized block", () =>
          client.getBlock({ blockTag: "finalized" })
        )
      ),
    block: async number =>
      toBlock(
        await quietly(`read block ${number}`, () =>
          client.getBlock({ blockNumber: number })
        )
      ),
    identity: (didHash, at) =>
      read(SIGVARA_ARC_TESTNET.identity, "getIdentity", didHash, at),
    reputation: (didHash, at) =>
      read(SIGVARA_ARC_TESTNET.reputation, "getReputation", didHash, at),
    totalScore: (didHash, at) =>
      read(SIGVARA_ARC_TESTNET.reputation, "getTotalScore", didHash, at),
    stake: (didHash, at) =>
      read(SIGVARA_ARC_TESTNET.staking, "getStake", didHash, at),
    hasMinimumStake: (didHash, at) =>
      read(SIGVARA_ARC_TESTNET.staking, "hasMinimumStake", didHash, at),
  };
}
