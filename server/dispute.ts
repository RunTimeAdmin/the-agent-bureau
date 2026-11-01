// Disputes from the subject (docs/disputes.md). Every step is a signed record,
// schema agent-bureau/dispute/v1, sealed whole in the Bureau's CounterAudit
// organization through the agent-bureau-dispute-v1 connector, which checks the
// same form as checkDisputeForm here. The Bureau checks the signatures itself:
// the subject's wallet (EIP-191) against the wallet the line names, or for a
// did:sigvara the agent address SigvaraIdentity holds, and the furnisher's key
// (Ed25519) against the key that signed the disputed line or one listed for it.
// A record whose checks fail is sealed and stored, and counts for nothing.
// Every settle checks each stored record again from the record itself
// (checkLineDisputes), and deriveDisputes turns the records that check into
// each dispute's state.
import { createPrivateKey, sign, verify } from "node:crypto";
import { recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DISPUTE_KINDS } from "../drizzle/schema";
import { FURNISHERS, type Furnisher } from "./furnishers";
import {
  currentDecisions,
  relationProblem,
  releaseFor,
  type Line,
  type Review,
} from "./lineState";
import {
  canonicalizeJson,
  decodeCanonicalBase64url,
  isRecord,
  parsePublicKey,
} from "./outcomeProof";
import {
  SIGVARA_ARC_TESTNET,
  parseSigvaraDid,
  sigvaraDidHash,
  type SigvaraClient,
} from "./sigvaraStanding";

export const DISPUTE_SCHEMA = "agent-bureau/dispute/v1";
export const DISPUTE_CONNECTOR_ID = "agent-bureau-dispute-v1";
// Domain separation: nothing else a wallet or a furnisher's key signs can pass
// for a dispute record.
export const DISPUTE_SIGNING_CONTEXT = `${DISPUTE_SCHEMA}\n`;
// The furnisher's time to answer, from when CounterAudit sealed the dispute.
export const RESPONSE_DAYS = 15;
const DAY_MS = 86_400_000;

export type DisputeKind = (typeof DISPUTE_KINDS)[number];
const KINDS: readonly string[] = ["dispute", "response", "statement", "appeal"];

// ---- The records ----

export type WalletSigner = { type: "eip191"; address: string };
export type EvidenceItem =
  { tx_hash: string } | { url: string } | { note: string };
type Common = {
  schema: typeof DISPUTE_SCHEMA;
  dispute_id: string;
  signature: string;
};

export type DisputeFiling = Common & {
  kind: "dispute";
  line: { furnisher_id: string; event_id: string; signed_event_hash: string };
  subject_ref: Record<string, unknown>;
  signer: WalletSigner;
  reason: string;
  evidence?: EvidenceItem[];
  filed_at: string;
};
export type DisputeResponse = Common & {
  kind: "response";
  furnisher_id: string;
  key_id: string;
  response: "confirm";
  evidence: EvidenceItem[];
  responded_at: string;
};
export type DisputeStatement = Common & {
  kind: "statement";
  signer: WalletSigner;
  text: string;
  stated_at: string;
};
export type SubjectAppeal = Common & {
  kind: "appeal";
  party: "subject";
  signer: WalletSigner;
  reason: string;
  appealed_at: string;
};
export type FurnisherAppeal = Common & {
  kind: "appeal";
  party: "furnisher";
  furnisher_id: string;
  key_id: string;
  corrective_event_id: string;
  reason: string;
  appealed_at: string;
};
export type DisputeRecord =
  | DisputeFiling
  | DisputeResponse
  | DisputeStatement
  | SubjectAppeal
  | FurnisherAppeal;
/** A record the subject's wallet signs. */
export type WalletRecord = DisputeFiling | DisputeStatement | SubjectAppeal;
/** A record the furnisher's key signs. */
export type FurnisherRecord = DisputeResponse | FurnisherAppeal;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const FURNISHER_ID = /^fur_[a-z0-9]{6,32}$/;
const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WALLET_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
// 64 bytes in their one base64url spelling: the last character's spare bits are zero.
const FURNISHER_SIGNATURE = /^ed25519:[A-Za-z0-9_-]{85}[AQgw]$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_TEXT = 500;
const MAX_SUBJECT_REF_BYTES = 1024;
const MAX_EVIDENCE = 5;

const COMMON = ["schema", "kind", "dispute_id"];
// Each kind's fields, besides signature, which every record has.
const FIELDS: Record<string, { required: string[]; optional?: string[] }> = {
  dispute: {
    required: [
      ...COMMON,
      "line",
      "subject_ref",
      "signer",
      "reason",
      "filed_at",
    ],
    optional: ["evidence"],
  },
  response: {
    required: [
      ...COMMON,
      "furnisher_id",
      "key_id",
      "response",
      "evidence",
      "responded_at",
    ],
  },
  statement: { required: [...COMMON, "signer", "text", "stated_at"] },
  appeal_subject: {
    required: [...COMMON, "party", "signer", "reason", "appealed_at"],
  },
  appeal_furnisher: {
    required: [
      ...COMMON,
      "party",
      "furnisher_id",
      "key_id",
      "corrective_event_id",
      "reason",
      "appealed_at",
    ],
  },
};

export type FormCheck =
  { ok: true; record: DisputeRecord } | { ok: false; reason: string };

// The first field that is not allowed, or required and absent: objects are strict.
function fieldsProblem(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
  prefix = ""
): string | null {
  const allowed = [...required, ...optional];
  const extra = Object.keys(value).find(k => !allowed.includes(k));
  if (extra !== undefined) return `unexpected field ${prefix}${extra}`;
  const missing = required.find(k => !Object.hasOwn(value, k));
  return missing === undefined ? null : `missing field ${prefix}${missing}`;
}

function textProblem(name: string, value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_TEXT &&
    value.trim() !== ""
    ? null
    : `${name} is not 1 to ${MAX_TEXT} characters, or is blank`;
}

// The pattern, and a time Date.parse reads, as CounterAudit's connector checks it.
function timeProblem(name: string, value: unknown): string | null {
  return typeof value === "string" &&
    TIME.test(value) &&
    !Number.isNaN(Date.parse(value))
    ? null
    : `${name} is not a UTC time with milliseconds`;
}

function signerProblem(value: unknown): string | null {
  if (!isRecord(value)) return "signer is not an object";
  const fields = fieldsProblem(value, ["type", "address"], [], "signer.");
  if (fields) return fields;
  if (value.type !== "eip191") return "signer.type is not eip191";
  return typeof value.address === "string" && ADDRESS.test(value.address)
    ? null
    : "signer.address is not 0x and 40 hex characters";
}

function isHttpsUrl(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length > MAX_TEXT ||
    !value.startsWith("https://")
  ) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function evidenceProblem(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_EVIDENCE
  ) {
    return `evidence is not a list of 1 to ${MAX_EVIDENCE} items`;
  }
  for (const [i, item] of value.entries()) {
    const at = `evidence[${i}]`;
    const keys = isRecord(item) ? Object.keys(item) : [];
    if (
      !isRecord(item) ||
      keys.length !== 1 ||
      !["tx_hash", "url", "note"].includes(keys[0])
    ) {
      return `${at} is not exactly one of tx_hash, url or note`;
    }
    if ("tx_hash" in item) {
      if (typeof item.tx_hash !== "string" || !TX_HASH.test(item.tx_hash)) {
        return `${at}.tx_hash is not 0x and 64 hex characters`;
      }
    } else if ("url" in item) {
      if (!isHttpsUrl(item.url)) {
        return `${at}.url is not an https URL of at most ${MAX_TEXT} characters`;
      }
    } else if (
      typeof item.note !== "string" ||
      item.note.length < 1 ||
      item.note.length > MAX_TEXT
    ) {
      return `${at}.note is not 1 to ${MAX_TEXT} characters`;
    }
  }
  return null;
}

const idProblem = (
  name: string,
  value: unknown,
  pattern: RegExp,
  what: string
) =>
  typeof value === "string" && pattern.test(value)
    ? null
    : `${name} is not ${what}`;

/**
 * Checks a record's form exactly as CounterAudit's agent-bureau-dispute-v1
 * connector does, before anything is sealed. Says nothing about the signature
 * beyond its shape: checkWalletRecord and checkFurnisherRecord check that.
 */
export function checkDisputeForm(value: unknown): FormCheck {
  const fail = (reason: string): FormCheck => ({ ok: false, reason });
  if (!isRecord(value)) return fail("not a JSON object");
  if (value.schema !== DISPUTE_SCHEMA) {
    return fail(`schema is not ${DISPUTE_SCHEMA}`);
  }
  if (typeof value.kind !== "string" || !KINDS.includes(value.kind)) {
    return fail("kind is not dispute, response, statement or appeal");
  }
  let shape = value.kind;
  if (value.kind === "appeal") {
    if (value.party !== "subject" && value.party !== "furnisher") {
      return fail("party is not subject or furnisher");
    }
    shape = `appeal_${value.party}`;
  }
  const { required, optional = [] } = FIELDS[shape];
  const fields = fieldsProblem(value, [...required, "signature"], optional);
  if (fields) return fail(fields);
  const problems: (string | null)[] = [
    idProblem("dispute_id", value.dispute_id, UUID, "a lowercase UUID"),
  ];
  const v = value;
  switch (shape) {
    case "dispute": {
      const line = v.line;
      problems.push(
        !isRecord(line)
          ? "line is not an object"
          : (fieldsProblem(
              line,
              ["furnisher_id", "event_id", "signed_event_hash"],
              [],
              "line."
            ) ??
              idProblem(
                "line.furnisher_id",
                line.furnisher_id,
                FURNISHER_ID,
                "a furnisher id"
              ) ??
              idProblem(
                "line.event_id",
                line.event_id,
                EVENT_ID,
                "an event id"
              ) ??
              idProblem(
                "line.signed_event_hash",
                line.signed_event_hash,
                HEX64,
                "64 lowercase hex characters"
              )),
        !isRecord(v.subject_ref)
          ? "subject_ref is not an object"
          : Buffer.byteLength(canonicalizeJson(v.subject_ref), "utf8") >
              MAX_SUBJECT_REF_BYTES
            ? `subject_ref is over ${MAX_SUBJECT_REF_BYTES} bytes as canonical JSON`
            : null,
        signerProblem(v.signer),
        textProblem("reason", v.reason),
        v.evidence === undefined ? null : evidenceProblem(v.evidence),
        timeProblem("filed_at", v.filed_at)
      );
      break;
    }
    case "response":
      problems.push(
        idProblem(
          "furnisher_id",
          v.furnisher_id,
          FURNISHER_ID,
          "a furnisher id"
        ),
        idProblem("key_id", v.key_id, KEY_ID, "a key id"),
        v.response === "confirm" ? null : "response is not confirm",
        evidenceProblem(v.evidence),
        timeProblem("responded_at", v.responded_at)
      );
      break;
    case "statement":
      problems.push(
        signerProblem(v.signer),
        textProblem("text", v.text),
        timeProblem("stated_at", v.stated_at)
      );
      break;
    case "appeal_subject":
      problems.push(
        signerProblem(v.signer),
        textProblem("reason", v.reason),
        timeProblem("appealed_at", v.appealed_at)
      );
      break;
    case "appeal_furnisher":
      problems.push(
        idProblem(
          "furnisher_id",
          v.furnisher_id,
          FURNISHER_ID,
          "a furnisher id"
        ),
        idProblem("key_id", v.key_id, KEY_ID, "a key id"),
        idProblem(
          "corrective_event_id",
          v.corrective_event_id,
          EVENT_ID,
          "an event id"
        ),
        textProblem("reason", v.reason),
        timeProblem("appealed_at", v.appealed_at)
      );
      break;
  }
  problems.push(
    signedByWalletShape(shape)
      ? idProblem(
          "signature",
          v.signature,
          WALLET_SIGNATURE,
          "0x and 130 hex characters"
        )
      : idProblem(
          "signature",
          v.signature,
          FURNISHER_SIGNATURE,
          "ed25519: and 64 bytes of canonical base64url"
        )
  );
  const problem = problems.find(p => p !== null);
  return problem ? fail(problem) : { ok: true, record: value as DisputeRecord };
}

function signedByWalletShape(shape: string): boolean {
  return (
    shape === "dispute" || shape === "statement" || shape === "appeal_subject"
  );
}

/** Whether the subject's wallet signs this record, rather than the furnisher's key. */
export function signedByWallet(record: DisputeRecord): record is WalletRecord {
  return (
    record.kind === "dispute" ||
    record.kind === "statement" ||
    (record.kind === "appeal" && record.party === "subject")
  );
}

// ---- Signing and checking signatures ----

/** What either key signs: the context line and the RFC 8785 canonical record without its signature. */
export function disputeSigningPayload(record: Record<string, unknown>): Buffer {
  const { signature: _signature, ...unsigned } = record;
  return Buffer.from(
    DISPUTE_SIGNING_CONTEXT + canonicalizeJson(unsigned),
    "utf8"
  );
}

/** A wallet private key as 64 hex characters, with or without 0x, or null. */
export function readWalletKey(text: string): Hex | null {
  const value = text.trim();
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex as Hex) : null;
}

/** The address of a wallet private key. */
export function walletAddress(privateKey: Hex): string {
  return privateKeyToAccount(privateKey).address;
}

/** Signs a record with a wallet: EIP-191 personal_sign over the payload bytes as a raw message. */
export async function signWithWallet(
  record: Record<string, unknown>,
  privateKey: Hex
): Promise<Record<string, unknown>> {
  const { signature: _signature, ...unsigned } = record;
  const signature = await privateKeyToAccount(privateKey).signMessage({
    message: { raw: new Uint8Array(disputeSigningPayload(unsigned)) },
  });
  return { ...unsigned, signature };
}

/** Signs a record with a furnisher's Ed25519 key (PKCS#8 PEM). */
export function signWithFurnisherKey(
  record: Record<string, unknown>,
  privateKeyPem: string
): Record<string, unknown> {
  const { signature: _signature, ...unsigned } = record;
  const signature = sign(
    null,
    disputeSigningPayload(unsigned),
    createPrivateKey(privateKeyPem)
  );
  return {
    ...unsigned,
    signature: `ed25519:${signature.toString("base64url")}`,
  };
}

/** Whether the record's signer address made its EIP-191 signature. */
export async function walletSignatureVerifies(
  record: WalletRecord
): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({
      message: { raw: new Uint8Array(disputeSigningPayload(record)) },
      signature: record.signature as Hex,
    });
    return recovered.toLowerCase() === record.signer.address.toLowerCase();
  } catch {
    return false;
  }
}

/** Whether this Ed25519 public key (ed25519:...) made the record's signature. */
export function furnisherSignatureVerifies(
  record: FurnisherRecord,
  publicKey: string
): boolean {
  const bytes = decodeCanonicalBase64url(
    record.signature.slice("ed25519:".length),
    64
  );
  if (!bytes) return false;
  try {
    return verify(
      null,
      disputeSigningPayload(record),
      parsePublicKey(publicKey),
      bytes
    );
  } catch {
    return false;
  }
}

// A MariaDB server older than 10.5.2 returns JSON columns as text.
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

/** The disputed line as the checks need it: its furnisher and subject, and its signed event and receipt, which name the key that signed it. */
export type KeyedLine = {
  furnisherId: string;
  subjectRef: unknown;
  signedEvent: unknown;
  receipt: unknown;
};

export type Check = { ok: boolean; problem: string | null };

/**
 * Checks a furnisher's record against the key that signed the disputed line
 * (the key_id in the line's signed event, with the public key CounterAudit's
 * receipt for the line names for that furnisher and key) or a key
 * server/furnishers.ts lists for that furnisher. A record being submitted
 * needs a listed key to be active (activeKeysOnly); a stored record keeps
 * checking with a listed key revoked since, as stored lines keep their checks.
 * A record from another furnisher than the line's never checks.
 */
export function checkFurnisherRecord(
  record: FurnisherRecord,
  line: Pick<KeyedLine, "furnisherId" | "signedEvent" | "receipt">,
  furnishers: Record<string, Furnisher>,
  options: { activeKeysOnly?: boolean } = {}
): Check {
  const fail = (problem: string): Check => ({ ok: false, problem });
  if (record.furnisher_id !== line.furnisherId) {
    return fail(
      `the record names ${record.furnisher_id}, not the line's furnisher ${line.furnisherId}`
    );
  }
  const keys: string[] = [];
  const event = asRecord(line.signedEvent);
  const claim = asRecord(line.receipt)?.outcome_claim;
  const signer = isRecord(claim) ? claim.signer : null;
  if (
    event?.key_id === record.key_id &&
    isRecord(signer) &&
    typeof signer.public_key === "string" &&
    (signer.key_id === undefined || signer.key_id === record.key_id) &&
    (signer.furnisher_id === undefined ||
      signer.furnisher_id === line.furnisherId)
  ) {
    keys.push(signer.public_key);
  }
  const listed = Object.hasOwn(furnishers, record.furnisher_id)
    ? furnishers[record.furnisher_id]
    : undefined;
  const key =
    listed && Object.hasOwn(listed.keys, record.key_id)
      ? listed.keys[record.key_id]
      : undefined;
  if (key && (key.status === "active" || !options.activeKeysOnly)) {
    keys.push(key.publicKey);
  }
  if (keys.length === 0) {
    return fail(
      `${record.key_id} is neither the key that signed the line nor ${options.activeKeysOnly ? "an active key" : "a key"} server/furnishers.ts lists for ${record.furnisher_id}`
    );
  }
  return keys.some(k => furnisherSignatureVerifies(record, k))
    ? { ok: true, problem: null }
    : fail(
        `the signature does not verify with ${record.furnisher_id}'s key ${record.key_id}`
      );
}

export type SubjectControl = Check & {
  /** For a did:sigvara: the agent address SigvaraIdentity held, as read. */
  controller: string | null;
};

/**
 * For a did:sigvara subject, the agent address SigvaraIdentity holds at the
 * latest finalized block on the pinned chain, or why there is none; null for
 * any other subject. Throws when Sigvara cannot be read.
 */
export async function readController(
  subjectRef: unknown,
  sigvara: SigvaraClient
): Promise<SubjectControl | null> {
  const ref = asRecord(subjectRef);
  const did = ref ? parseSigvaraDid(ref) : null;
  if (!did) return null;
  const none = (problem: string) => ({ ok: false, problem, controller: null });
  if (did.chainId !== SIGVARA_ARC_TESTNET.chainId) {
    return none(
      `the did names chain ${did.chainId}; the Bureau reads Sigvara on chain ${SIGVARA_ARC_TESTNET.chainId} only`
    );
  }
  const chainId = await sigvara.chainId();
  if (chainId !== SIGVARA_ARC_TESTNET.chainId) {
    throw new Error(
      `the Arc RPC serves chain ${chainId}, not ${SIGVARA_ARC_TESTNET.chainId}`
    );
  }
  const block = await sigvara.finalizedBlock();
  const identity = await sigvara.identity(
    sigvaraDidHash(did.chainId, did.address),
    block.number
  );
  if (identity.registeredAt === 0n) {
    return none(
      `the agent is not registered in SigvaraIdentity at block ${block.number}`
    );
  }
  return { ok: true, problem: null, controller: identity.agentAddress };
}

/**
 * Why the wallet that signed a subject's record does not control the line's
 * subject, or null. The subject is the wallet the line names, or for a
 * did:sigvara the agent address read from SigvaraIdentity when the record was
 * submitted (controller). Other subjects cannot be matched to a key yet
 * (Phase 3).
 */
export function subjectControlProblem(
  subjectRef: unknown,
  signerAddress: string,
  controller: string | null
): string | null {
  const ref = asRecord(subjectRef);
  const signer = signerAddress.toLowerCase();
  if (ref && Object.keys(ref).length === 1 && typeof ref.wallet === "string") {
    if (!ADDRESS.test(ref.wallet)) {
      return "the line names a wallet that is not an EVM address, which no EIP-191 signature can show control of";
    }
    return ref.wallet.toLowerCase() === signer
      ? null
      : `signed by ${signerAddress}, not the wallet the line names (${ref.wallet})`;
  }
  if (!ref || !parseSigvaraDid(ref)) {
    return "only a line about an EVM wallet or a did:sigvara can be disputed yet; matching other subjects to a key is Phase 3";
  }
  if (controller === null) {
    return "no agent address was read from SigvaraIdentity for the did:sigvara when the record was submitted";
  }
  return controller.toLowerCase() === signer
    ? null
    : `signed by ${signerAddress}, not the agent address SigvaraIdentity holds for the did:sigvara (${controller})`;
}

/**
 * Whether the wallet that signed a subject's record controls the line's
 * subject, reading SigvaraIdentity for a did:sigvara, as pnpm dispute submit
 * checks it. Throws when Sigvara cannot be read.
 */
export async function checkSubjectControl(
  subjectRef: unknown,
  signerAddress: string,
  sigvara: SigvaraClient
): Promise<SubjectControl> {
  const read = await readController(subjectRef, sigvara);
  if (read && !read.ok) return read;
  const controller = read?.controller ?? null;
  const problem = subjectControlProblem(subjectRef, signerAddress, controller);
  return { ok: problem === null, problem, controller };
}

export type RecordCheck = Check & {
  signatureOk: boolean;
  /** Null for a furnisher's record. */
  subjectControlOk: boolean | null;
};

/**
 * Checks one stored record from the record itself, as every settle does: its
 * form, that it belongs to the dispute and kind it is stored under, and its
 * signature: the subject's against the line's subject (for a did:sigvara, the
 * agent address stored when it was submitted, the one stored value trusted
 * here), the furnisher's against the line's furnisher's key. What the checks
 * found when it was submitted is not read: an edited flag changes nothing, and a
 * record erased with its line's source counts for nothing.
 */
export async function checkStoredRecord(
  row: Pick<
    StoredDisputeRecord,
    "disputeId" | "kind" | "record" | "controllerAddress"
  >,
  line: KeyedLine,
  furnishers: Record<string, Furnisher>,
  options: { activeKeysOnly?: boolean } = {}
): Promise<RecordCheck> {
  const fail = (problem: string): RecordCheck => ({
    ok: false,
    problem,
    signatureOk: false,
    subjectControlOk: null,
  });
  const value = asRecord(row.record);
  if (!value) return fail("the record was erased with the line's source");
  const form = checkDisputeForm(value);
  if (!form.ok) return fail(form.reason);
  const record = form.record;
  if (record.dispute_id !== row.disputeId || record.kind !== row.kind) {
    return fail("the record is stored under another dispute or kind");
  }
  if (!signedByWallet(record)) {
    const check = checkFurnisherRecord(record, line, furnishers, options);
    return { ...check, signatureOk: check.ok, subjectControlOk: null };
  }
  const signatureOk = await walletSignatureVerifies(record);
  const control = subjectControlProblem(
    line.subjectRef,
    record.signer.address,
    row.controllerAddress ?? null
  );
  const problems = [
    ...(signatureOk
      ? []
      : [`the signature does not verify as ${record.signer.address}'s`]),
    ...(control ? [control] : []),
  ];
  return {
    ok: problems.length === 0,
    problem: problems.length ? problems.join("; ") : null,
    signatureOk,
    subjectControlOk: control === null,
  };
}

// ---- What the records add up to ----

/**
 * A stored record (dispute_records). signatureOk, subjectControlOk and
 * checkProblem say what the checks found when it was submitted; nothing reads
 * them to decide a dispute (checkStoredRecord checks the record again).
 */
export type StoredDisputeRecord = {
  id: number;
  disputeId: string;
  kind: string;
  record: unknown;
  packetId: string;
  sequence: number | null;
  sealedAt: Date | string;
  signatureOk: boolean;
  subjectControlOk: boolean | null;
  checkProblem?: string | null;
  controllerAddress?: string | null;
};

export type DisputeState =
  "open" | "confirmed" | "corrected" | "withdrawn" | "lapsed";
export type AppealState = "open" | "upheld" | "dismissed";

export type Appeal = {
  party: "subject" | "furnisher";
  state: AppealState;
  sealedAt: Date;
  packetId: string;
  /** A furnisher's appeal: the line that corrects the removed one. */
  correctiveEventId: string | null;
};

export type Dispute = {
  disputeId: string;
  state: DisputeState;
  /** When CounterAudit sealed the dispute record. */
  filedAt: Date;
  /** The furnisher's deadline: RESPONSE_DAYS after filedAt. */
  respondBy: Date;
  /** When CounterAudit sealed the furnisher's confirmation, for a confirmed dispute. */
  confirmedAt: Date | null;
  /** The subject's one statement, once the furnisher confirmed. */
  statement: string | null;
  appeal: Appeal | null;
};

const time = (value: Date | string) =>
  (value instanceof Date ? value : new Date(value)).getTime();

type Counted = { row: StoredDisputeRecord; record: DisputeRecord; at: number };

// Seal order: CounterAudit's time, then its sequence (one chain), then the row.
function sealOrder(a: Counted, b: Counted): number {
  return (
    a.at - b.at ||
    (a.row.sequence ?? 0) - (b.row.sequence ?? 0) ||
    a.row.id - b.row.id
  );
}

/** The line's subject as its signed event names it, or the stored copy where it has none. */
export function lineSubject(line: {
  subjectRef: unknown;
  signedEvent?: unknown;
}): unknown {
  const event = asRecord(line.signedEvent);
  return event && isRecord(event.subject_ref)
    ? event.subject_ref
    : line.subjectRef;
}

/** A stored record with the result of checking it again (checkStoredRecord). */
export type CheckedDisputeRecord = StoredDisputeRecord & { check: RecordCheck };

/**
 * The line with each of its stored dispute records checked again from the
 * record itself (checkStoredRecord), as deriveDisputes needs them. The subject
 * is read from the line's signed event where the line has one, as a file reads
 * it. Every settle, file, queue and subject view checks them so.
 */
export async function checkLineDisputes<T extends Line>(
  line: T,
  furnishers: Record<string, Furnisher> = FURNISHERS
): Promise<T & { checkedDisputes: CheckedDisputeRecord[] }> {
  const keyed: KeyedLine = {
    furnisherId: line.furnisherId,
    subjectRef: lineSubject(line),
    signedEvent: line.signedEvent,
    receipt: line.receipt,
  };
  const checkedDisputes: CheckedDisputeRecord[] = [];
  for (const row of line.disputeRecords ?? []) {
    checkedDisputes.push({
      ...row,
      check: await checkStoredRecord(row, keyed, furnishers),
    });
  }
  return { ...line, checkedDisputes };
}

// The records that count: they checked again just now, so their form holds,
// they belong to the dispute and kind they were stored under, and their
// signature is the line's subject's or furnisher's.
function countedRecords(rows: CheckedDisputeRecord[]): Counted[] {
  const counted: Counted[] = [];
  for (const row of rows) {
    if (!row.check.ok) continue;
    const form = checkDisputeForm(asRecord(row.record));
    if (!form.ok) continue;
    const at = time(row.sealedAt);
    if (!Number.isFinite(at)) continue;
    counted.push({ row, record: form.record, at });
  }
  return counted.sort(sealOrder);
}

// Decisions on a line sealed in the review log after a time, as the review log counts them.
function decidedAfter(reviews: Review[], at: number): Review[] {
  return reviews.filter(
    r => r.sealedAt !== undefined && r.sealedAt.getTime() > at
  );
}

export type DisputeInput = {
  /** The disputed line. */
  line: Line;
  /** Its stored dispute records, each checked again (checkLineDisputes). */
  records: CheckedDisputeRecord[];
  /** The same furnisher's lines whose relation points at it, with their seal times. */
  relating: Line[];
  /** The review log's decisions on a line. */
  reviewsOf: (line: Line) => Review[];
  now: Date;
};

/**
 * Each dispute on a line that counts, with its state and its appeal's, from
 * its checked records, the lines relating to it, the review log and now
 * (docs/disputes.md, "What happens"). A dispute counts once its own record
 * checked and names this version of the line. The furnisher answers with
 * what CounterAudit sealed before the deadline, RESPONSE_DAYS after the
 * dispute: a line of its own that withdraws the disputed one (withdrawn), or
 * corrects or supersedes it (corrected), or a confirmation. A withdrawal
 * outranks a correction, which outranks a confirmation, in whatever order they
 * came. With none, the dispute is open until the deadline and lapsed from it,
 * and nothing sealed after the deadline changes a lapse. After a confirmation
 * the subject's first statement counts. One appeal
 * counts per dispute: the subject's after a confirmation, decided by review
 * decisions on the line sealed after it (a rejection upholds it, the approvals
 * a release needs dismiss it); or the furnisher's after a lapse, naming a line
 * that corrects the removed one, decided by decisions on that line sealed after
 * it (a release upholds it, a rejection dismisses it).
 */
export function deriveDisputes(input: DisputeInput): Dispute[] {
  const { line, relating, now } = input;
  const counted = countedRecords(input.records);
  const ids = [...new Set(counted.map(c => c.row.disputeId))];
  const disputes: Dispute[] = [];
  for (const id of ids) {
    const records = counted.filter(c => c.row.disputeId === id);
    const filing = records.find(c => c.record.kind === "dispute");
    if (!filing || filing.record.kind !== "dispute") continue;
    const about = filing.record.line;
    if (
      about.furnisher_id !== line.furnisherId ||
      about.event_id !== line.eventId ||
      about.signed_event_hash !== line.signedEventHash
    ) {
      continue;
    }
    const deadline = filing.at + RESPONSE_DAYS * DAY_MS;
    const after = (c: Counted) => sealOrder(c, filing) > 0;
    // A relating line acts on the dispute only if CounterAudit sealed it before the deadline.
    const acting = relating.filter(
      r =>
        r.caCreatedAt !== undefined &&
        time(r.caCreatedAt) < deadline &&
        relationProblem(r, line) === null
    );
    const has = (...types: string[]) =>
      acting.some(
        r => r.relationType !== null && types.includes(r.relationType)
      );
    const confirm = records.find(
      c => c.record.kind === "response" && after(c) && c.at < deadline
    );
    let state: DisputeState;
    if (has("withdraws")) state = "withdrawn";
    else if (has("corrects", "supersedes")) state = "corrected";
    else if (confirm) state = "confirmed";
    else state = now.getTime() >= deadline ? "lapsed" : "open";

    const confirmed = state === "confirmed" ? confirm : undefined;
    const statement = confirmed
      ? records.find(
          c => c.record.kind === "statement" && sealOrder(c, confirmed) > 0
        )
      : undefined;

    let appeal: Appeal | null = null;
    for (const c of records) {
      if (c.record.kind !== "appeal") continue;
      const sealedAt = new Date(c.at);
      if (c.record.party === "subject") {
        if (!confirmed || sealOrder(c, confirmed) <= 0) continue;
        const decisions = decidedAfter(input.reviewsOf(line), c.at);
        const rejected = currentDecisions(line, decisions).some(
          d => d.decision === "reject" && !d.suspended
        );
        appeal = {
          party: "subject",
          state: rejected
            ? "upheld"
            : releaseFor(line, decisions).released
              ? "dismissed"
              : "open",
          sealedAt,
          packetId: c.row.packetId,
          correctiveEventId: null,
        };
        break;
      }
      if (state !== "lapsed" || c.at < deadline) continue;
      const correctiveId = c.record.corrective_event_id;
      const corrective = relating.find(
        r =>
          r.eventId === correctiveId &&
          r.relationType === "corrects" &&
          relationProblem(r, line) === null
      );
      if (!corrective) continue;
      const decisions = decidedAfter(input.reviewsOf(corrective), c.at);
      const rejected = currentDecisions(corrective, decisions).some(
        d => d.decision === "reject" && !d.suspended
      );
      appeal = {
        party: "furnisher",
        state: rejected
          ? "dismissed"
          : releaseFor(corrective, decisions).released
            ? "upheld"
            : "open",
        sealedAt,
        packetId: c.row.packetId,
        correctiveEventId: correctiveId,
      };
      break;
    }

    disputes.push({
      disputeId: id,
      state,
      filedAt: new Date(filing.at),
      respondBy: new Date(deadline),
      confirmedAt: confirmed ? new Date(confirmed.at) : null,
      statement:
        statement && statement.record.kind === "statement"
          ? statement.record.text
          : null,
      appeal,
    });
  }
  return disputes;
}

/**
 * The dispute a line shows: one that lapsed, which removes the line for good,
 * or else the one filed last. Null when no dispute on it counts.
 */
export function currentDispute(disputes: Dispute[]): Dispute | null {
  const lapsed = disputes.find(d => d.state === "lapsed");
  if (lapsed) return lapsed;
  return disputes.reduce<Dispute | null>(
    (last, d) =>
      !last || d.filedAt.getTime() >= last.filedAt.getTime() ? d : last,
    null
  );
}

/**
 * The dispute a line shows, from its records as checkLineDisputes checked them.
 * A line read with dispute records that were not checked is an error, never a
 * line without a dispute: that would put a removed line back on a file.
 */
export function disputeOf(
  line: Line,
  relating: Line[],
  reviewsOf: (line: Line) => Review[],
  now: Date
): Dispute | null {
  if (!line.checkedDisputes) {
    if (line.disputeRecords && line.disputeRecords.length > 0) {
      throw new Error(
        `${line.furnisherId}/${line.eventId}: its dispute records were not checked`
      );
    }
    return null;
  }
  if (line.checkedDisputes.length === 0) return null;
  return currentDispute(
    deriveDisputes({
      line,
      records: line.checkedDisputes,
      relating,
      reviewsOf,
      now,
    })
  );
}
