// pnpm dispute: subject disputes (docs/disputes.md). sign is a testing tool
// that signs a record with a wallet or furnisher key; a subject's real wallet
// signs it elsewhere. submit and settle run where the intake runs: submit
// checks a signed record, seals it through CounterAudit's
// agent-bureau-dispute-v1 connector with the Bureau's ingest key, stores it and
// settles its line; settle closes lapsed disputes.
import { readFile, writeFile } from "node:fs/promises";
import { ENV } from "./_core/env";
import { duplicateKey } from "./agentFile";
import { ingestDisputeRecord, type DisputeIngestResult } from "./counteraudit";
import {
  findDisputeLine,
  findRelatingOutcomeLines,
  getDisputeLine,
  insertDisputeRecord,
  listDisputeRecords,
  listOutcomeLines,
  schemaReady,
} from "./db";
import {
  checkDisputeForm,
  checkFurnisherRecord,
  checkSubjectControl,
  currentDispute,
  deriveDisputes,
  furnisherSignatureVerifies,
  readWalletKey,
  signWithFurnisherKey,
  signWithWallet,
  signedByWallet,
  walletAddress,
  walletSignatureVerifies,
  type Dispute,
  type DisputeRecord,
} from "./dispute";
import { FURNISHERS, type Furnisher } from "./furnishers";
import {
  displayStateFor,
  lineStates,
  relationProblem,
  type Line,
} from "./lineState";
import { canonicalizeJson, isRecord } from "./outcomeProof";
import { reviewerPublicKey } from "./reviewDecision";
import type { ReviewLog } from "./reviewLog";
import { loadReviewLog, reviewsFor, settle } from "./settleLines";
import { rpcSigvaraClient, type SigvaraClient } from "./sigvaraStanding";

export const USAGE = [
  "Usage:",
  "  pnpm dispute sign <record.json> --wallet-key <file> --out <file>",
  "  pnpm dispute sign <record.json> --furnisher-key <file> --out <file>",
  "  pnpm dispute submit <signed.json>",
  "  pnpm dispute settle",
].join("\n");

export type DisputeIO = {
  readText(path: string): Promise<string>;
  // Writes a new file; fails if it exists.
  writeNewFile(path: string, text: string): Promise<void>;
  log(line: string): void;
  now(): Date;
  ingest(record: Record<string, unknown>): Promise<DisputeIngestResult>;
  sigvara: SigvaraClient;
  furnishers: Record<string, Furnisher>;
};

const defaultIO: DisputeIO = {
  readText: path => readFile(path, "utf8"),
  writeNewFile: (path, text) => writeFile(path, text, { flag: "wx" }),
  log: line => console.log(line),
  now: () => new Date(),
  ingest: ingestDisputeRecord,
  sigvara: rpcSigvaraClient(ENV.arcTestnetRpcUrl),
  furnishers: FURNISHERS,
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// One JSON object from a file, refusing a key that appears twice in one object.
async function readRecord(
  path: string,
  io: DisputeIO
): Promise<Record<string, unknown> | null> {
  let text: string;
  let value: unknown;
  try {
    text = await io.readText(path);
    value = JSON.parse(text);
  } catch (error) {
    io.log(`Cannot read one JSON record in ${path}: ${describeError(error)}`);
    return null;
  }
  const duplicate = duplicateKey(text);
  if (duplicate !== null) {
    io.log(
      `Refused: the key ${duplicate} appears twice in one object, so the record could be read two ways.`
    );
    return null;
  }
  if (!isRecord(value)) {
    io.log(`${path} does not hold a JSON object.`);
    return null;
  }
  return value;
}

const walletKind = (record: Record<string, unknown>) =>
  record.kind === "dispute" ||
  record.kind === "statement" ||
  (record.kind === "appeal" && record.party === "subject");

async function signCommand(args: string[], io: DisputeIO): Promise<number> {
  const [path, ...rest] = args;
  const flags = readFlags(rest);
  if (
    !path ||
    path.startsWith("--") ||
    !flags ||
    !flags.out ||
    Object.keys(flags).length !== 2 ||
    !(flags["wallet-key"] || flags["furnisher-key"])
  ) {
    io.log(USAGE);
    return 2;
  }
  const record = await readRecord(path, io);
  if (!record) return 2;
  const byWallet = Boolean(flags["wallet-key"]);
  if (byWallet !== walletKind(record)) {
    io.log(
      byWallet
        ? "This record is signed with the furnisher's key: use --furnisher-key."
        : "This record is signed with the subject's wallet: use --wallet-key."
    );
    return 2;
  }
  const keyFile = flags["wallet-key"] ?? flags["furnisher-key"];
  let keyText: string;
  try {
    keyText = await io.readText(keyFile);
  } catch (error) {
    io.log(`Cannot read the key in ${keyFile}: ${describeError(error)}`);
    return 2;
  }
  let signed: Record<string, unknown>;
  let verifies: (record: DisputeRecord) => Promise<boolean>;
  if (byWallet) {
    const key = readWalletKey(keyText);
    if (!key) {
      io.log(
        `${keyFile} does not hold a wallet private key (64 hex characters).`
      );
      return 2;
    }
    const address = walletAddress(key);
    const named = isRecord(record.signer) ? record.signer.address : undefined;
    if (
      typeof named !== "string" ||
      named.toLowerCase() !== address.toLowerCase()
    ) {
      io.log(
        `This key is wallet ${address}; the record's signer.address must name it. Nothing signed.`
      );
      return 2;
    }
    signed = await signWithWallet(record, key);
    verifies = async r =>
      signedByWallet(r) && (await walletSignatureVerifies(r));
  } else {
    let publicKey: string;
    try {
      publicKey = reviewerPublicKey(keyText);
      signed = signWithFurnisherKey(record, keyText);
    } catch (error) {
      io.log(`Cannot sign with the key in ${keyFile}: ${describeError(error)}`);
      return 2;
    }
    verifies = async r =>
      !signedByWallet(r) && furnisherSignatureVerifies(r, publicKey);
  }
  const form = checkDisputeForm(signed);
  if (!form.ok) {
    io.log(`Not signed: ${form.reason}.`);
    return 2;
  }
  if (!(await verifies(form.record))) {
    io.log("Not signed: the signature does not verify with this key.");
    return 2;
  }
  try {
    await io.writeNewFile(flags.out, `${JSON.stringify(signed)}\n`);
  } catch (error) {
    io.log(`Cannot write ${flags.out}: ${describeError(error)}`);
    return 2;
  }
  io.log(
    `Signed and written to ${flags.out}. The operator seals it with: pnpm dispute submit ${flags.out}`
  );
  return 0;
}

async function needDatabase(io: DisputeIO): Promise<boolean> {
  if (!(await schemaReady())) {
    io.log(
      "The database is not reachable or lacks the dispute tables. Start the server once so it applies migrations (or run pnpm db:migrate), then try again."
    );
    return false;
  }
  return true;
}

type DisputeLine = NonNullable<Awaited<ReturnType<typeof findDisputeLine>>>;

const sameJson = (a: unknown, b: unknown) => {
  try {
    return canonicalizeJson(a) === canonicalizeJson(b);
  } catch {
    return false;
  }
};

// A MariaDB server older than 10.5.2 returns JSON columns as text.
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Why this record cannot go on its line or dispute as they stand now, or null.
 * Checked before anything is sealed; what counts is decided from the stored
 * records afterwards (deriveDisputes), by when CounterAudit sealed each.
 */
function refusal(
  record: DisputeRecord,
  line: DisputeLine,
  relating: Line[],
  log: ReviewLog,
  disputes: Dispute[]
): string | null {
  const ref = `${line.furnisherId}/${line.eventId}`;
  if (record.kind === "dispute") {
    const reviews = reviewsFor(line, log);
    const shown = currentDispute(disputes);
    const states = lineStates(line, relating, reviews, shown?.state ?? null);
    const display = displayStateFor(states);
    if (
      !states.released ||
      (display !== "released" && display !== "disputed")
    ) {
      const shown =
        display === "removed" || states.released ? display : "not released";
      return `${ref} is ${shown}: only a line on a file, released or disputed, can be disputed`;
    }
    const open = disputes.find(d => d.state === "open");
    return open
      ? `${ref} already carries open dispute ${open.disputeId}; the furnisher must answer by ${open.respondBy.toISOString()}`
      : null;
  }
  const dispute = disputes.find(d => d.disputeId === record.dispute_id);
  if (!dispute) {
    return `dispute ${record.dispute_id} does not count on ${ref}`;
  }
  const id = `dispute ${dispute.disputeId}`;
  if (record.kind === "response") {
    return dispute.state === "open"
      ? null
      : `${id} is ${dispute.state}; the furnisher answers an open dispute only`;
  }
  if (record.kind === "statement") {
    if (dispute.state !== "confirmed") {
      return `${id} is ${dispute.state}; a statement follows the furnisher's confirmation`;
    }
    return dispute.statement !== null
      ? `the subject's one statement on ${id} is recorded already`
      : null;
  }
  if (dispute.appeal) {
    return `${id} already has an appeal, by the ${dispute.appeal.party}; it can be appealed once`;
  }
  if (record.party === "subject") {
    return dispute.state === "confirmed"
      ? null
      : `${id} is ${dispute.state}; the subject appeals a line the furnisher confirmed`;
  }
  if (dispute.state !== "lapsed") {
    return `${id} is ${dispute.state}; the furnisher appeals a removal after a lapse`;
  }
  const corrective = relating.find(
    r =>
      r.eventId === record.corrective_event_id &&
      r.relationType === "corrects" &&
      relationProblem(r, line) === null
  );
  return corrective
    ? null
    : `${record.corrective_event_id} is not a stored line of ${line.furnisherId} that corrects ${line.eventId}; send it through the intake first`;
}

// What a dispute stands at, for the operator.
function describeDispute(dispute: Dispute): string {
  const id = `Dispute ${dispute.disputeId}`;
  const appeal = dispute.appeal
    ? `; appeal by the ${dispute.appeal.party} ${dispute.appeal.state}`
    : "";
  switch (dispute.state) {
    case "open":
      return `${id} is open: the furnisher must answer by ${dispute.respondBy.toISOString()}.`;
    case "confirmed":
      return `${id} is confirmed by the furnisher${dispute.statement !== null ? ", with the subject's statement beside it" : ""}${appeal}.`;
    case "lapsed":
      return `${id} lapsed at ${dispute.respondBy.toISOString()} without an answer: the line is removed${appeal}.`;
    default:
      return `${id} is closed as ${dispute.state}.`;
  }
}

async function submit(args: string[], io: DisputeIO): Promise<number> {
  if (args.length !== 1 || args[0].startsWith("--")) {
    io.log(USAGE);
    return 2;
  }
  const missing = [
    ["COUNTERAUDIT_ORG_ID", ENV.counterauditOrgId],
    ["COUNTERAUDIT_INGEST_KEY", ENV.counterauditIngestKey],
    ["DATABASE_URL", ENV.databaseUrl],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    io.log(
      `Not set: ${missing.map(([name]) => name).join(", ")}. See docs/disputes.md.`
    );
    return 2;
  }
  const value = await readRecord(args[0], io);
  if (!value) return 2;
  const form = checkDisputeForm(value);
  if (!form.ok) {
    io.log(`Not sealed: ${form.reason}.`);
    return 2;
  }
  const record = form.record;
  if (!(await needDatabase(io))) return 2;
  const now = io.now();
  const stored = await listDisputeRecords(record.dispute_id);
  const same = stored.find(r => sameJson(parsed(r.record), record));
  if (same) {
    io.log(
      `Already sealed and stored as packet ${same.packetId}. Nothing sent.`
    );
    return 0;
  }

  // The line the record is about: named by a dispute, or the line of the dispute it answers.
  let line: DisputeLine | undefined;
  if (record.kind === "dispute") {
    if (stored.length > 0) {
      io.log(
        `Not sealed: dispute_id ${record.dispute_id} is used already; a new dispute needs a new id.`
      );
      return 2;
    }
    const { furnisher_id, event_id, signed_event_hash } = record.line;
    line = await findDisputeLine(furnisher_id, event_id);
    if (!line || line.signedEventHash !== signed_event_hash) {
      io.log(
        `Not sealed: the Bureau holds no line ${furnisher_id}/${event_id} with signed_event_hash ${signed_event_hash}.`
      );
      return 2;
    }
    if (line.expiredAt) {
      io.log(
        `Not sealed: ${furnisher_id}/${event_id} expired with its source and is on no file.`
      );
      return 2;
    }
    if (!sameJson(parsed(line.subjectRef), record.subject_ref)) {
      io.log(
        `Not sealed: subject_ref is not exactly the line's (${canonicalizeJson(parsed(line.subjectRef) ?? null)}).`
      );
      return 2;
    }
  } else {
    const filing = stored.find(
      r => r.kind === "dispute" && r.signatureOk && r.subjectControlOk === true
    );
    if (!filing) {
      io.log(
        stored.length > 0
          ? `Not sealed: dispute ${record.dispute_id} counts for nothing; its own record did not check.`
          : `Not sealed: the Bureau holds no dispute ${record.dispute_id}.`
      );
      return 2;
    }
    line = await getDisputeLine(filing.outcomeEventId);
    if (!line) {
      io.log(
        `Not sealed: the line of dispute ${record.dispute_id} is not held.`
      );
      return 2;
    }
  }

  const log = await loadReviewLog();
  const reviewsOf = (l: Line) => reviewsFor(l, log);
  const relating = await findRelatingOutcomeLines(
    line.furnisherId,
    line.eventId
  );
  const before = deriveDisputes({
    line,
    records: line.disputeRecords,
    relating,
    reviewsOf,
    now,
  });
  const refused = refusal(record, line, relating, log, before);
  if (refused) {
    io.log(`Not sealed: ${refused}.`);
    return 2;
  }

  // The Bureau's own checks. A record that fails them is still sealed and kept, and counts for
  // nothing (docs/disputes.md, "Sealing and checking").
  const problems: string[] = [];
  let signatureOk: boolean;
  let subjectControlOk: boolean | null = null;
  let controller: string | null = null;
  if (signedByWallet(record)) {
    signatureOk = await walletSignatureVerifies(record);
    if (!signatureOk) {
      problems.push(
        `the signature does not verify as ${record.signer.address}'s`
      );
    }
    try {
      const control = await checkSubjectControl(
        parsed(line.subjectRef),
        record.signer.address,
        io.sigvara
      );
      subjectControlOk = control.ok;
      controller = control.controller;
      if (control.problem) problems.push(control.problem);
    } catch (error) {
      io.log(
        `Not sealed: Sigvara could not be read to check who controls the subject: ${describeError(error)}.`
      );
      return 1;
    }
  } else {
    const check = checkFurnisherRecord(record, line, io.furnishers);
    signatureOk = check.ok;
    if (check.problem) problems.push(check.problem);
  }

  let sealed: DisputeIngestResult;
  try {
    sealed = await io.ingest(record);
  } catch (error) {
    sealed = {
      kind: "refused",
      status: null,
      error: "network_error",
      message: describeError(error),
    };
  }
  if (sealed.kind === "refused") {
    io.log(
      `Not sealed: CounterAudit refused it (${sealed.status ?? "no answer"} ${sealed.error}${sealed.message ? `: ${sealed.message}` : ""}).`
    );
    return 1;
  }
  const { packet } = sealed;
  const counts = signatureOk && subjectControlOk !== false;
  const added = await insertDisputeRecord({
    disputeId: record.dispute_id,
    kind: record.kind,
    outcomeEventId: line.id,
    record,
    packetId: packet.packet_id,
    sequence: packet.sequence,
    sealedAt: new Date(packet.created_at),
    receipt: packet.receipt,
    signatureOk,
    subjectControlOk,
    checkProblem: problems.length ? problems.join("; ").slice(0, 500) : null,
    controllerAddress: controller,
  });
  io.log(
    `${sealed.kind === "sealed" ? "Sealed" : "Already sealed"} in CounterAudit as packet ${packet.packet_id}${packet.sequence === null ? "" : `, sequence ${packet.sequence}`}, at ${packet.created_at}; ${added ? "stored" : "stored already"}.`
  );
  io.log(
    counts
      ? `Checked: the signature${subjectControlOk ? `, and control of the subject${controller ? ` (SigvaraIdentity's agent address ${controller})` : ""}` : ""}.`
      : `It counts for nothing: ${problems.join("; ")}.`
  );

  const after = await getDisputeLine(line.id);
  if (!after) return counts ? 0 : 1;
  const changed = await settle(after, log, now);
  const dispute = deriveDisputes({
    line: after,
    records: after.disputeRecords,
    relating,
    reviewsOf,
    now,
  }).find(d => d.disputeId === record.dispute_id);
  if (dispute) io.log(describeDispute(dispute));
  const ref = `${line.furnisherId}/${line.eventId}`;
  io.log(
    changed
      ? `${ref} is now shown as ${changed}.`
      : `${ref} stays shown as ${after.displayState}.`
  );
  return counts ? 0 : 1;
}

// Closes lapsed disputes: settles every line with a subject dispute as of now, which removes a
// line whose dispute lapsed.
async function settleCommand(io: DisputeIO): Promise<number> {
  if (!ENV.databaseUrl) {
    io.log("Not set: DATABASE_URL. See docs/disputes.md.");
    return 2;
  }
  if (!(await needDatabase(io))) return 2;
  const now = io.now();
  const log = await loadReviewLog();
  const lines = (await listOutcomeLines()).filter(
    l => l.disputeRecords.length > 0
  );
  let changes = 0;
  for (const line of lines) {
    const changed = await settle(line, log, now);
    if (!changed) continue;
    changes++;
    const relating = await findRelatingOutcomeLines(
      line.furnisherId,
      line.eventId
    );
    const why = deriveDisputes({
      line,
      records: line.disputeRecords,
      relating,
      reviewsOf: l => reviewsFor(l, log),
      now,
    })
      .filter(d => d.state === "lapsed")
      .map(
        d =>
          ` (dispute ${d.disputeId} lapsed at ${d.respondBy.toISOString()} without an answer from the furnisher)`
      )
      .join("");
    io.log(
      `${line.furnisherId}/${line.eventId}: ${line.displayState} -> ${changed}${changed === "removed" ? why : ""}`
    );
  }
  io.log(
    `${lines.length} line${lines.length === 1 ? "" : "s"} with subject disputes settled, ${changes} changed.`
  );
  return 0;
}

/**
 * Runs one pnpm dispute command. Returns the exit code: 0 done, 1 when a
 * sealed record counts for nothing or CounterAudit or Sigvara could not be
 * used, 2 when nothing was sent.
 */
export async function runDispute(
  argv: string[],
  io: DisputeIO = defaultIO
): Promise<number> {
  const [command, ...args] = argv.filter(arg => arg !== "--");
  switch (command) {
    case "sign":
      return signCommand(args, io);
    case "submit":
      return submit(args, io);
    case "settle":
      if (args.length > 0) {
        io.log(USAGE);
        return 2;
      }
      return settleCommand(io);
    default:
      io.log(USAGE);
      return 2;
  }
}
