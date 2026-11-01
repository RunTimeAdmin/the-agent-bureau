// An agent's file (docs/agent-file.md): the lines the Bureau holds on one
// subject that reviewers released, as of one time, signed with a Bureau key
// pinned in server/bureauFileKeys.ts. What a line says is read from the signed
// event the reviewers approved, never from the table's copies of its fields.
// Each line points at the CounterAudit packet that sealed it, whose public
// proof anyone can fetch and check against the line with `pnpm file verify`.
import { readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, randomUUID, sign, verify } from "node:crypto";
import canonicalize from "canonicalize";
import { ENV } from "./_core/env";
import { BUREAU_FILE_KEYS } from "./bureauFileKeys";
import { fetchProof } from "./counteraudit";
import { COUNTERAUDIT_EXPORT_KEYS } from "./counterauditKeys";
import { listFileLines, schemaReady } from "./db";
import { readEventFields } from "./furnishIntake";
import { FURNISHERS, type Furnisher } from "./furnishers";
import {
  displayStateFor,
  lineStates,
  subjectKey,
  type DisplayState,
  type Line,
  type Release,
  type Review,
} from "./lineState";
import {
  decodeCanonicalBase64url,
  isRecord,
  parsePublicKey,
  signedEventHash,
  verifyLineProof,
  type CheckResult,
  type Jwks,
} from "./outcomeProof";
import { evidenceLabel, PAYMENT_OUTCOMES } from "./review";
import { newReviewerKey, reviewerPublicKey } from "./reviewDecision";
import { loadReviewLog, reviewsFor } from "./settleLines";

export const FILE_SCHEMA = "agent-bureau/file/v1";
// Domain separation: nothing else a file key signs can pass for a file.
const SIGNING_CONTEXT = "agent-bureau/file/v1\n";

// Review finding M-04 (docs/independent-payer.md): every file carries it.
export const PAYMENT_DISCLOSURE =
  "A settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered.";

const FACTS_DISCLOSURE =
  "A file states outcomes that furnishers reported, with dates and sources, after reviewers released them. It is not a score, a grade or a recommendation.";
const SOLO_TEST_DISCLOSURE =
  "A line released solo_test is test data released by one reviewer; live data needs two different reviewers.";
const TEST_DATA_DISCLOSURE =
  "Every line on this file is test data: furnished to test the Bureau, not about real dealings.";
const TESTNET_REVIEWERS_DISCLOSURE =
  "The reviewers who released these lines are testnet keys the Bureau's operator holds, not independent reviewers, so two_person here does not mean two independent people.";
const HISTORY_DISCLOSURE =
  "history lists released lines the same furnisher later withdrew or replaced. They are kept as a record of what was reported, not as current facts.";

// What a file cannot show yet, said rather than left out (bureau-spec.md,
// "What a file contains").
export const NOT_ON_FILE = [
  "Subject matching: only lines naming exactly this subject reference are here (EVM wallets compare without case). Other spellings, registrations, wallets or DIDs of the same operator are not matched (Phase 3).",
  "Lines reviewers have not released are held and not shown, whatever their outcome.",
  "Public record, payment history and third-party standing such as Sigvara's score are not assembled into files yet.",
  "Disputes and statements from the subject, and inquiries, are not built yet.",
];

// Subscribers see a furnisher's category, not its name (bureau-spec.md). Listed
// by pull request with the furnisher.
export const FURNISHER_CATEGORIES: Record<string, string> = {
  fur_bureaupilot01: "Bureau pilot test furnisher",
};
const UNLISTED_CATEGORY = "category not listed";

export type FileLine = {
  outcome: string;
  /** The furnisher's claim, inside its signed event; never independently checked. */
  occurred_at: string;
  received_at: string;
  sealed_at: string;
  data_class: "test" | "live";
  furnisher_category: string;
  display_state: Exclude<DisplayState, "unverified">;
  released: Release;
  /** What the evidence check proved, by the M-04 names, or that reviewers waived it. */
  evidence: string;
  payment?: {
    subject_control: "unproven";
    payer_independence_screen: "clear" | "flagged" | "inconclusive";
  };
  counteraudit: {
    packet_id: string;
    org_id: string;
    sequence: number | null;
    entry_hash: string;
    signed_event_hash: string;
    proof_url: string;
  };
};

export type AgentFile = {
  schema: typeof FILE_SCHEMA;
  file_id: string;
  issued_at: string;
  subject: { subject_ref: Record<string, unknown>; matching: "exact" };
  reviewers: "independent" | "operator_held_testnet";
  /** Released lines that stand: released, or disputed and shown with the dispute. */
  furnished_outcomes: FileLine[];
  /** Released lines the furnisher later withdrew or replaced. */
  history: FileLine[];
  disclosures: string[];
  not_on_file: string[];
};

export type SignedAgentFile = AgentFile & {
  signature: { algorithm: "ed25519"; key_id: string; value: string };
};

/** A stored line, as listFileLines reads it. */
export type StoredLine = Line & {
  outcome: string;
  occurredAt: Date | string;
  receivedAt: Date | string;
  caCreatedAt: Date | string;
  packetId: string;
  entryHash: string;
  sequence: number | null;
  signedEvent: unknown;
};

// ---- What a file is about ----

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DID = /^did:[a-z0-9]+:\S+$/;
const CHAINS = ["arc", "base", "bnb", "robinhood", "solana"];

const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every(k => Object.hasOwn(value, k));

/** A subject_ref in one of the outcome event v1 forms, or why it is not. */
export function readSubjectRef(
  value: unknown
): Record<string, unknown> | string {
  const hint =
    'a subject_ref as outcome event v1 has it: {"wallet":"0x..."}, {"did":"did:..."} or {"chain":"arc","registry":"...","id":"..."}';
  if (!isRecord(value)) return `not ${hint}`;
  const str = (k: string, max: number) =>
    typeof value[k] === "string" &&
    (value[k] as string).length >= 1 &&
    (value[k] as string).length <= max;
  if (exactKeys(value, ["wallet"])) {
    const w = value.wallet;
    return typeof w === "string" &&
      (EVM_ADDRESS.test(w) || SOLANA_ADDRESS.test(w))
      ? value
      : "wallet is not an EVM or Solana address";
  }
  if (exactKeys(value, ["did"])) {
    return str("did", 256) && DID.test(value.did as string)
      ? value
      : "did is not a DID";
  }
  if (exactKeys(value, ["chain", "registry", "id"])) {
    return CHAINS.includes(value.chain as string) &&
      str("registry", 64) &&
      str("id", 128)
      ? value
      : "chain, registry or id is not in the v1 form";
  }
  return `not ${hint}`;
}

// ---- Lines from their signed events ----

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

/**
 * The line as its signed event says it, or why it cannot be read so. The event
 * must hash to the signedEventHash reviewers signed, and name the row's own
 * furnisher and event id; its subject, outcome, time and relation then replace
 * the table's copies, which nothing signs.
 */
export function fromSignedEvent(row: StoredLine): StoredLine | string {
  const label = `${row.furnisherId}/${row.eventId}`;
  const event = asRecord(row.signedEvent);
  if (!event) return `${label}: no signed event stored`;
  let hash: string;
  try {
    hash = signedEventHash(event);
  } catch {
    return `${label}: the signed event has no canonical form`;
  }
  if (hash !== row.signedEventHash) {
    return `${label}: the signed event does not hash to the line's signed_event_hash`;
  }
  const fields = readEventFields(event);
  if (typeof fields === "string") return `${label}: ${fields}`;
  if (
    fields.furnisherId !== row.furnisherId ||
    fields.eventId !== row.eventId
  ) {
    return `${label}: the signed event names another furnisher or event`;
  }
  return {
    ...row,
    outcome: fields.outcome,
    subjectRef: fields.subjectRef,
    occurredAt: fields.occurredAt,
    relationType: fields.relationType,
    relationTargetEventId: fields.relationTargetEventId,
  };
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

// A cap hit, an incomplete history or no screen at all is inconclusive, never
// clear (docs/independent-payer.md).
function screenOf(line: StoredLine): "clear" | "flagged" | "inconclusive" {
  const screen = asRecord(line.evidenceResult)?.funding_screen;
  const result = isRecord(screen) ? screen.result : null;
  return result === "clear" || result === "flagged" ? result : "inconclusive";
}

export type AssembleOptions = {
  now: Date;
  /** The Bureau's own CounterAudit organization, where unlisted furnishers' lines are sealed. */
  bureauOrgId: string;
  testnetReviewers: boolean;
  fileId?: string;
  proofBase?: string;
  furnishers?: Record<string, Furnisher>;
};

/**
 * The file for one subject: its lines that reviewers released, newest first,
 * with what the Bureau knows of each. Pure: the caller reads the lines and the
 * review log. Lines are read from their signed events; one that cannot be is
 * left off, and listed in `skipped` for the operator, not on the file.
 */
export function assembleFile(
  subjectRef: Record<string, unknown>,
  rows: StoredLine[],
  reviewsOf: (line: Line) => Review[],
  options: AssembleOptions
): { file: AgentFile; skipped: string[] } {
  const furnishers = options.furnishers ?? FURNISHERS;
  const proofBase = (options.proofBase ?? ENV.counterauditApiUrl).replace(
    /\/+$/,
    ""
  );
  const skipped: string[] = [];
  const lines: StoredLine[] = [];
  for (const row of rows) {
    const line = fromSignedEvent(row);
    if (typeof line === "string") skipped.push(line);
    else lines.push(line);
  }
  const key = subjectKey(subjectRef);
  const standing: FileLine[] = [];
  const history: FileLine[] = [];
  for (const line of lines) {
    if (subjectKey(line.subjectRef) !== key) continue;
    // The same furnisher's lines whose relation points at this one, matched
    // exactly as findRelatingOutcomeLines does, from their signed events.
    const relating = lines.filter(
      r =>
        r.furnisherId === line.furnisherId &&
        r.relationTargetEventId === line.eventId
    );
    const states = lineStates(line, relating, reviewsOf(line));
    if (!states.released) continue;
    const display = displayStateFor(states);
    if (display === "unverified") continue;
    const listed = Object.hasOwn(furnishers, line.furnisherId)
      ? furnishers[line.furnisherId].counterauditOrgId
      : undefined;
    const entry: FileLine = {
      outcome: line.outcome,
      occurred_at: iso(line.occurredAt),
      received_at: iso(line.receivedAt),
      sealed_at: iso(line.caCreatedAt),
      data_class: line.dataClass,
      furnisher_category: Object.hasOwn(FURNISHER_CATEGORIES, line.furnisherId)
        ? FURNISHER_CATEGORIES[line.furnisherId]
        : UNLISTED_CATEGORY,
      display_state: display,
      released: states.released,
      evidence: states.evidence_verified
        ? evidenceLabel(line.outcome, "verified")
        : "waived_by_reviewers",
      ...(PAYMENT_OUTCOMES.has(line.outcome)
        ? {
            payment: {
              subject_control: "unproven" as const,
              payer_independence_screen: screenOf(line),
            },
          }
        : {}),
      counteraudit: {
        packet_id: line.packetId,
        // Where the intake checked the proof: a listed furnisher's own
        // organization, else the Bureau's.
        org_id: listed ?? options.bureauOrgId,
        sequence: line.sequence,
        entry_hash: line.entryHash,
        signed_event_hash: line.signedEventHash,
        proof_url: `${proofBase}/v1/proofs/${encodeURIComponent(line.packetId)}`,
      },
    };
    (display === "withdrawn" || display === "superseded"
      ? history
      : standing
    ).push(entry);
  }
  const order = (a: FileLine, b: FileLine) =>
    b.occurred_at.localeCompare(a.occurred_at) ||
    a.counteraudit.packet_id.localeCompare(b.counteraudit.packet_id);
  standing.sort(order);
  history.sort(order);
  const all = [...standing, ...history];
  const disclosures = [FACTS_DISCLOSURE, PAYMENT_DISCLOSURE];
  if (history.length > 0) disclosures.push(HISTORY_DISCLOSURE);
  if (all.some(l => l.released === "solo_test"))
    disclosures.push(SOLO_TEST_DISCLOSURE);
  if (options.testnetReviewers) disclosures.push(TESTNET_REVIEWERS_DISCLOSURE);
  if (all.length > 0 && all.every(l => l.data_class === "test"))
    disclosures.push(TEST_DATA_DISCLOSURE);
  return {
    file: {
      schema: FILE_SCHEMA,
      file_id: options.fileId ?? randomUUID(),
      issued_at: options.now.toISOString(),
      subject: { subject_ref: subjectRef, matching: "exact" },
      reviewers: options.testnetReviewers
        ? "operator_held_testnet"
        : "independent",
      furnished_outcomes: standing,
      history,
      disclosures,
      not_on_file: NOT_ON_FILE,
    },
    skipped,
  };
}

// ---- Signing ----

function signingPayload(file: unknown): Buffer {
  const canonical = canonicalize(file);
  if (canonical === undefined)
    throw new Error("the file has no canonical form");
  return Buffer.concat([
    Buffer.from(SIGNING_CONTEXT, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);
}

/** Signs a file with a pinned key; refuses a key that is not the one pinned under keyId. */
export function signFile(
  file: AgentFile,
  privateKeyPem: string,
  keyId: string,
  keys: Record<string, string> = BUREAU_FILE_KEYS
): SignedAgentFile {
  if (!Object.hasOwn(keys, keyId)) {
    throw new Error(`key ${keyId} is not pinned in server/bureauFileKeys.ts`);
  }
  if (reviewerPublicKey(privateKeyPem) !== keys[keyId]) {
    throw new Error(`this private key is not the one pinned as ${keyId}`);
  }
  const value = sign(
    null,
    signingPayload(file),
    createPrivateKey(privateKeyPem)
  ).toString("base64url");
  return { ...file, signature: { algorithm: "ed25519", key_id: keyId, value } };
}

const pass: CheckResult = { ok: true };
const fail = (detail: string): CheckResult => ({ ok: false, detail });

/** Whether a pinned Bureau key signed this file, unchanged. */
export function checkFileSignature(
  signed: unknown,
  keys: Record<string, string> = BUREAU_FILE_KEYS
): CheckResult {
  try {
    if (!isRecord(signed)) return fail("not a file");
    const { signature, ...file } = signed;
    if (file.schema !== FILE_SCHEMA) return fail(`not an ${FILE_SCHEMA} file`);
    if (!isRecord(signature) || signature.algorithm !== "ed25519") {
      return fail("no ed25519 signature");
    }
    const keyId = signature.key_id;
    if (typeof keyId !== "string" || !Object.hasOwn(keys, keyId)) {
      return fail("signed with a key that is not pinned");
    }
    const bytes =
      typeof signature.value === "string"
        ? decodeCanonicalBase64url(signature.value, 64)
        : null;
    if (!bytes)
      return fail("the signature is not 64 bytes of canonical base64url");
    return verify(
      null,
      signingPayload(file),
      parsePublicKey(keys[keyId]),
      bytes
    )
      ? pass
      : fail(
          `the signature does not verify with ${keyId}: the file was changed or signed with another key`
        );
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ---- Reading an untrusted file ----

/**
 * The first object key that appears twice in the same object of this JSON
 * text, or null. JSON.parse keeps the last one silently, so a file with a
 * duplicate could read one way here and another way to a different parser.
 * Call only on text JSON.parse accepted.
 */
export function duplicateKey(text: string): string | null {
  const stack: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return key;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      expectKey = stack.at(-1) instanceof Set;
    }
  }
  return null;
}

// Text from an untrusted file, safe to print: no terminal control characters.
function printable(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : (JSON.stringify(value) ?? String(value));
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").slice(0, 300);
}

// ---- pnpm file ----

export const USAGE = [
  "Usage:",
  "  pnpm file keygen <private-key-file>",
  "  pnpm file assemble --subject <subject_ref JSON> --key <private-key-file> --key-id <key id> --out <file>",
  "  pnpm file verify <file> [--subject <subject_ref JSON>] [--max-age-days <days>] [--offline]",
].join("\n");

export type FileIO = {
  readText(path: string): Promise<string>;
  // Writes a new file readable only by its owner; fails if it exists.
  writeNewPrivateFile(path: string, text: string): Promise<void>;
  // Writes a new file; fails if it exists.
  writeNewFile(path: string, text: string): Promise<void>;
  log(line: string): void;
  now(): Date;
  fetchProof: typeof fetchProof;
  jwks: Jwks;
  keys: Record<string, string>;
  furnishers: Record<string, Furnisher>;
};

const defaultIO: FileIO = {
  readText: path => readFile(path, "utf8"),
  writeNewPrivateFile: (path, text) =>
    writeFile(path, text, { flag: "wx", mode: 0o600 }),
  writeNewFile: (path, text) => writeFile(path, text, { flag: "wx" }),
  log: line => console.log(line),
  now: () => new Date(),
  fetchProof,
  jwks: COUNTERAUDIT_EXPORT_KEYS,
  keys: BUREAU_FILE_KEYS,
  furnishers: FURNISHERS,
};

function describeError(error: unknown): string {
  return printable(error instanceof Error ? error.message : String(error));
}

// --name value pairs; null when the arguments do not parse or a flag repeats.
function readFlags(args: string[]): Record<string, string> | null {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      Object.hasOwn(flags, name.slice(2))
    ) {
      return null;
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

function parseSubjectFlag(text: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  return readSubjectRef(value);
}

async function keygen(args: string[], io: FileIO): Promise<number> {
  if (args.length !== 1) {
    io.log(USAGE);
    return 2;
  }
  const { privateKeyPem, publicKey } = newReviewerKey();
  try {
    await io.writeNewPrivateFile(args[0], privateKeyPem);
  } catch (error) {
    io.log(`Could not write ${args[0]}: ${describeError(error)}`);
    return 1;
  }
  io.log(`Wrote the private key to ${args[0]}, readable only by you.`);
  io.log(`Public key: ${publicKey}`);
  io.log(
    "Pin it in server/bureauFileKeys.ts under a new key id, by pull request, before signing with it."
  );
  return 0;
}

async function assemble(args: string[], io: FileIO): Promise<number> {
  const flags = readFlags(args);
  if (
    !flags ||
    !flags.subject ||
    !flags.key ||
    !flags["key-id"] ||
    !flags.out ||
    Object.keys(flags).length !== 4
  ) {
    io.log(USAGE);
    return 2;
  }
  const subjectRef = parseSubjectFlag(flags.subject);
  if (typeof subjectRef === "string") {
    io.log(`--subject: ${subjectRef}.`);
    return 2;
  }
  let privateKeyPem: string;
  try {
    privateKeyPem = await io.readText(flags.key);
  } catch (error) {
    io.log(`Could not read ${flags.key}: ${describeError(error)}`);
    return 1;
  }
  const missing = [
    ["DATABASE_URL", ENV.databaseUrl],
    ["COUNTERAUDIT_ORG_ID", ENV.counterauditOrgId],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    io.log(
      `Not set: ${missing.map(([name]) => name).join(", ")}. See docs/agent-file.md.`
    );
    return 2;
  }
  if (!(await schemaReady())) {
    io.log("The database is not reachable or lacks the outcome tables.");
    return 1;
  }
  const log = await loadReviewLog();
  const { file, skipped } = assembleFile(
    subjectRef,
    (await listFileLines()) as StoredLine[],
    line => reviewsFor(line, log),
    {
      now: io.now(),
      bureauOrgId: ENV.counterauditOrgId,
      testnetReviewers: log.testnet,
      furnishers: io.furnishers,
    }
  );
  // A stored line whose signed event does not check means the store was
  // changed or damaged; a withdrawal that stops acting that way could put a
  // line back on a file, so nothing is signed until it is fixed.
  if (skipped.length > 0) {
    for (const reason of skipped) io.log(printable(reason));
    io.log(
      "Not signed: these lines' signed events do not check. Re-run the intake for them, or find out who changed them."
    );
    return 1;
  }
  let signed: SignedAgentFile;
  try {
    signed = signFile(file, privateKeyPem, flags["key-id"], io.keys);
  } catch (error) {
    io.log(`Not signed: ${describeError(error)}`);
    return 1;
  }
  try {
    await io.writeNewFile(flags.out, `${JSON.stringify(signed, null, 2)}\n`);
  } catch (error) {
    io.log(`Could not write ${flags.out}: ${describeError(error)}`);
    return 1;
  }
  const count = signed.furnished_outcomes.length;
  io.log(
    `File ${signed.file_id} for ${canonicalize(subjectRef)}: ${count} line${count === 1 ? "" : "s"} standing and ${signed.history.length} in history, signed with ${flags["key-id"]}, written to ${flags.out}.`
  );
  if (count + signed.history.length === 0) {
    io.log(
      "No released line names exactly this subject. Matching is exact apart from EVM wallets, so check the spelling."
    );
  }
  if (log.testnet) {
    io.log(
      "The review log has only the operator-held testnet reviewers, so only test-data lines can be on a file, and the file says so."
    );
  }
  return 0;
}

async function verifyCommand(args: string[], io: FileIO): Promise<number> {
  const offline = args.at(-1) === "--offline";
  const [path, ...rest] = offline ? args.slice(0, -1) : args;
  const flags = readFlags(rest);
  if (
    !path ||
    path.startsWith("--") ||
    !flags ||
    Object.keys(flags).some(k => k !== "subject" && k !== "max-age-days")
  ) {
    io.log(USAGE);
    return 2;
  }
  const expectedSubject =
    flags.subject === undefined ? null : parseSubjectFlag(flags.subject);
  if (typeof expectedSubject === "string") {
    io.log(`--subject: ${expectedSubject}.`);
    return 2;
  }
  const maxAgeDays =
    flags["max-age-days"] === undefined ? null : Number(flags["max-age-days"]);
  if (maxAgeDays !== null && !(Number.isFinite(maxAgeDays) && maxAgeDays > 0)) {
    io.log("--max-age-days is a positive number of days.");
    return 2;
  }
  let text: string;
  let file: unknown;
  try {
    text = await io.readText(path);
    file = JSON.parse(text);
  } catch (error) {
    io.log(`Could not read ${path} as JSON: ${describeError(error)}`);
    return 1;
  }
  const duplicate = duplicateKey(text);
  if (duplicate !== null) {
    io.log(
      `Refused: the key ${printable(duplicate)} appears twice in one object, so the file could be read two ways.`
    );
    return 1;
  }
  const signature = checkFileSignature(file, io.keys);
  io.log(
    `Bureau signature: ${signature.ok ? "verified" : `FAILED: ${printable(signature.detail)}`}`
  );
  if (!signature.ok) return 1;
  const signed = file as SignedAgentFile;
  io.log(`About: ${printable(canonicalize(signed.subject?.subject_ref))}`);
  io.log(
    `File ${printable(signed.file_id)}, issued ${printable(signed.issued_at)}, reviewers ${printable(signed.reviewers)}`
  );
  let failed = 0;
  if (expectedSubject) {
    const same =
      isRecord(signed.subject?.subject_ref) &&
      subjectKey(signed.subject.subject_ref) === subjectKey(expectedSubject);
    io.log(
      same
        ? "Subject: as expected"
        : "Subject: FAILED: this file is about another subject"
    );
    if (!same) failed++;
  }
  if (maxAgeDays !== null) {
    const issued = new Date(String(signed.issued_at)).getTime();
    const age = io.now().getTime() - issued;
    // A few minutes' clock difference is allowed; a file from the future is not.
    const fresh =
      Number.isFinite(issued) &&
      age >= -5 * 60_000 &&
      age <= maxAgeDays * 86_400_000;
    io.log(
      fresh
        ? `Age: within ${maxAgeDays} days`
        : `Age: FAILED: not issued within the last ${maxAgeDays} days`
    );
    if (!fresh) failed++;
  }
  const lines = [signed.furnished_outcomes, signed.history];
  if (!lines.every(Array.isArray)) {
    io.log("The file has no furnished_outcomes or history list.");
    return 1;
  }
  const entries = lines.flat() as unknown[];
  if (offline) {
    io.log(
      `${entries.length} line(s); their proofs were not fetched (--offline).`
    );
    return failed === 0 ? 0 : 1;
  }
  // The signature held, but each line is still read as untrusted JSON.
  for (const entry of entries) {
    const line: Record<string, unknown> = isRecord(entry) ? entry : {};
    const ca: Record<string, unknown> = isRecord(line.counteraudit)
      ? line.counteraudit
      : {};
    const packetId = typeof ca.packet_id === "string" ? ca.packet_id : "";
    const fetched = packetId
      ? await io.fetchProof(packetId)
      : { ok: false as const, status: null, message: "no packet id" };
    if (!fetched.ok) {
      failed++;
      io.log(
        `${printable(packetId || "(no packet)")}: proof not fetched: ${printable(fetched.message)}`
      );
      continue;
    }
    const result = verifyLineProof({
      proof: fetched.proof,
      jwks: io.jwks,
      furnishers: io.furnishers,
      packetId,
      orgId: String(ca.org_id ?? ""),
      sequence: typeof ca.sequence === "number" ? ca.sequence : null,
      entryHash: String(ca.entry_hash ?? ""),
      signedEventHash: String(ca.signed_event_hash ?? ""),
      outcome: String(line.outcome ?? ""),
      sealedAt: String(line.sealed_at ?? ""),
    });
    if (result.ok) {
      io.log(
        `${printable(packetId)}: proof verified (${printable(line.outcome)}, sealed in ${printable(ca.org_id)})`
      );
    } else {
      failed++;
      const bad = Object.entries(result.checks)
        .filter(([, c]) => !c.ok)
        .map(
          ([name, c]) => `${name}${c.detail ? `: ${printable(c.detail)}` : ""}`
        );
      io.log(`${printable(packetId)}: proof FAILED: ${bad.join("; ")}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

export async function runFile(
  argv: string[],
  io: FileIO = defaultIO
): Promise<number> {
  const [command, ...args] = argv.filter(arg => arg !== "--");
  switch (command) {
    case "keygen":
      return keygen(args, io);
    case "assemble":
      return assemble(args, io);
    case "verify":
      return verifyCommand(args, io);
    default:
      io.log(USAGE);
      return 2;
  }
}
