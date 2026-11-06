// pnpm review: two-person review of stored lines (docs/two-person-review.md).
// keygen, sign, key and submit run on a reviewer's own machine and need no
// database; the private key never leaves it, and submit seals the record in the
// independent review log with the reviewer's own ingest key. sync, queue and
// settle run where the intake runs, against the Bureau's database.
import { readFile, writeFile } from "node:fs/promises";
import { ENV } from "./_core/env";
import {
  bindReviewLogOrg,
  findRelatingOutcomeLines,
  getReviewLogHead,
  getReviewLogMoveHead,
  getReviewLogSync,
  insertReviewLogRecords,
  listOutcomeLines,
  listReviewLogRecords,
  moveReviewLog,
  recordReviewLogCheckpoint,
  recordReviewLogSync,
  schemaReady,
} from "./db";
import {
  APPROVABLE_OPERATIONS,
  KEY_APPROVAL_SCHEMA,
  checkKeyApprovalForm,
  keyApprovalVerifies,
  payloadDigest,
  signKeyApproval,
  type ApprovableOperation,
} from "./keyApproval";
import {
  checkLineDisputes,
  currentDispute,
  deriveDisputes,
  type Dispute,
} from "./dispute";
import {
  ADMISSION_SCHEMA,
  MAX_PROBATION_DAYS,
  MIN_PROBATION_DAYS,
  checkAdmissionForm,
  signAdmission,
  type AdmissionGate,
  type AdmittedKey,
  type UnsignedAdmission,
} from "./furnisherAdmission";
import { FURNISHERS, type Furnisher } from "./furnishers";
import { lineStates, releaseFor, signedEvidenceStatus, type Line } from "./lineState";
import { isRecord } from "./outcomeProof";
import {
  REVIEW_SCHEMA,
  checkReviewDecision,
  evidenceDigest,
  newReviewerKey,
  reviewerPublicKey,
  signReviewDecision,
  type ReviewDecisionKind,
} from "./reviewDecision";
import {
  REVIEWER_KEY_SCHEMA,
  REVIEW_GENESIS,
  checkKeyRecordForm,
  genesisHash,
  signKeyRecord,
  type KeyChange,
  type ReviewLog,
} from "./reviewLog";
import {
  parseHead,
  readCheckpoint,
  pinnedOrgProblem,
  readReviewLog,
  submitReviewRecord,
  type Fetch,
} from "./reviewLogSync";
import {
  admissionFor,
  loadReviewLog,
  readReviewLogNow,
  reviewLogOrgProblem,
  reviewsFor,
  settle,
} from "./settleLines";
import { REVIEW_DECISIONS } from "../drizzle/schema";

export const USAGE = [
  "Usage:",
  "  pnpm review keygen <private-key-file>",
  "  pnpm review sign --key <private-key-file> --reviewer <rev_id> --line <furnisher_id>/<event_id> --hash <signed_event_hash> --data-class <test|live> --evidence <evidence_digest> --decision <approve|approve_with_waiver|reject> [--reason <text>] --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --genesis <reviewers.json> --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --add <rev_id> --name <name> --public-key <ed25519:...> [--reason <text>] --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --rotate <rev_id> --public-key <ed25519:...> [--reason <text>] --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --<suspend|reenable|remove> <rev_id> [--reason <text>] --out <record-file>",
  `  pnpm review admit --key <private-key-file> --reviewer <rev_id> --furnisher <fur_id> [--probation-days <${MIN_PROBATION_DAYS}-${MAX_PROBATION_DAYS}>] [--org <org_id> --furnisher-key <key_id>=<ed25519:...>] --out <record-file>`,
  "  pnpm review revoke-admission --key <private-key-file> --reviewer <rev_id> --furnisher <fur_id> --reason <text> --out <record-file>",
  "  pnpm review submit <record-file>",
  "  pnpm review approve-key --key <private-key-file> --reviewer <rev_id> --request <request.json> --out <approval-file>",
  "  pnpm review sync",
  "  pnpm review move",
  "  pnpm review head",
  "  pnpm review queue",
  "  pnpm review admissions",
  "  pnpm review settle",
].join("\n");

export type ReviewIO = {
  readText(path: string): Promise<string>;
  // Writes a new file readable only by its owner; fails if it exists.
  writeNewPrivateFile(path: string, text: string): Promise<void>;
  // Writes a new file; fails if it exists.
  writeNewFile(path: string, text: string): Promise<void>;
  log(line: string): void;
  now(): Date;
  fetch: Fetch;
  // The listed furnishers; server/furnishers.ts when not given.
  furnishers?: Record<string, Furnisher>;
};

const defaultIO: ReviewIO = {
  readText: path => readFile(path, "utf8"),
  writeNewPrivateFile: (path, text) =>
    writeFile(path, text, { flag: "wx", mode: 0o600 }),
  writeNewFile: (path, text) => writeFile(path, text, { flag: "wx" }),
  log: line => console.log(line),
  now: () => new Date(),
  fetch: (url, init) => fetch(url, init),
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --name value pairs; null when the arguments do not parse.
function readFlags(args: string[]): Record<string, string> | null {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    // A flag given twice is refused, not silently overridden.
    if (!name?.startsWith("--") || value === undefined || Object.hasOwn(flags, name.slice(2))) {
      return null;
    }
    flags[name.slice(2)] = value;
  }
  return flags;
}

// The private key in a file, and the public key it makes; null after saying why.
async function readPrivateKey(
  path: string,
  io: ReviewIO
): Promise<{ privateKeyPem: string; publicKey: string } | null> {
  try {
    const privateKeyPem = await io.readText(path);
    return { privateKeyPem, publicKey: reviewerPublicKey(privateKeyPem) };
  } catch (error) {
    io.log(`Cannot read the private key in ${path}: ${describeError(error)}`);
    return null;
  }
}

// Writes a signed record to a new file, and shows it with what to do next.
async function writeRecord(
  path: string,
  record: object,
  io: ReviewIO,
  next = `Seal it with: pnpm review submit ${path}`
): Promise<number> {
  try {
    await io.writeNewFile(path, `${JSON.stringify(record)}\n`);
  } catch (error) {
    io.log(`Cannot write ${path}: ${describeError(error)}`);
    return 2;
  }
  io.log(`Signed and written to ${path}. ${next}\n${JSON.stringify(record)}`);
  return 0;
}

async function keygen(args: string[], io: ReviewIO): Promise<number> {
  if (args.length !== 1) {
    io.log(USAGE);
    return 2;
  }
  const { privateKeyPem, publicKey } = newReviewerKey();
  try {
    await io.writeNewPrivateFile(args[0], privateKeyPem);
  } catch (error) {
    io.log(`Cannot write ${args[0]}: ${describeError(error)}`);
    return 2;
  }
  io.log(
    [
      `Private key written to ${args[0]}. Keep it on this machine; it never goes to the Bureau.`,
      `Public key: ${publicKey}`,
      "Give the public key to the other reviewers. It counts once it is in the review log: in the genesis every first reviewer signs, or in an add two reviewers sign.",
    ].join("\n")
  );
  return 0;
}

async function signCommand(args: string[], io: ReviewIO): Promise<number> {
  const flags = readFlags(args);
  const required = [
    "key",
    "reviewer",
    "line",
    "hash",
    "data-class",
    "evidence",
    "decision",
    "out",
  ];
  if (
    !flags ||
    Object.keys(flags).some(
      name => !required.includes(name) && name !== "reason"
    ) ||
    required.some(name => !flags[name])
  ) {
    io.log(USAGE);
    return 2;
  }
  const slash = flags.line.indexOf("/");
  if (slash < 1) {
    io.log(
      "--line must be <furnisher_id>/<event_id>, as pnpm review queue prints it."
    );
    return 2;
  }
  if (!REVIEW_DECISIONS.includes(flags.decision as ReviewDecisionKind)) {
    io.log(`--decision must be one of ${REVIEW_DECISIONS.join(", ")}.`);
    return 2;
  }
  const key = await readPrivateKey(flags.key, io);
  if (!key) return 2;
  const decision = signReviewDecision(
    {
      schema: REVIEW_SCHEMA,
      reviewer_id: flags.reviewer,
      furnisher_id: flags.line.slice(0, slash),
      event_id: flags.line.slice(slash + 1),
      signed_event_hash: flags.hash,
      data_class: flags["data-class"] as "test" | "live",
      evidence_digest: flags.evidence,
      decision: flags.decision as ReviewDecisionKind,
      ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
      decided_at: io.now().toISOString(),
    },
    key.privateKeyPem
  );
  // The same checks the Bureau runs, against this key, before anything is
  // sealed. Whether it is the reviewer's current key is the review log's to say.
  const check = checkReviewDecision(
    decision,
    { [flags.reviewer]: { name: "", publicKey: key.publicKey } },
    io.now()
  );
  if (!check.ok) {
    io.log(`Not signed: ${check.reason}.`);
    return 2;
  }
  return writeRecord(flags.out, decision, io);
}

// The flag naming each kind of key change, and the other flags it needs.
const CHANGE_FLAGS: Record<Exclude<KeyChange["type"], "genesis">, string[]> = {
  add: ["name", "public-key"],
  rotate: ["public-key"],
  suspend: [],
  reenable: [],
  remove: [],
};

async function keyCommand(args: string[], io: ReviewIO): Promise<number> {
  const flags = readFlags(args);
  const kinds = flags
    ? ["genesis", ...Object.keys(CHANGE_FLAGS)].filter(k => k in flags)
    : [];
  const kind = kinds[0] as KeyChange["type"] | undefined;
  const needs =
    kind === "genesis" ? [] : kind ? CHANGE_FLAGS[kind] : [];
  const allowed = ["key", "signer", "out", "reason", ...kinds, ...needs];
  if (
    !flags ||
    !kind ||
    kinds.length !== 1 ||
    Object.keys(flags).some(name => !allowed.includes(name)) ||
    ["key", "signer", "out", kind, ...needs].some(name => !flags[name])
  ) {
    io.log(USAGE);
    return 2;
  }
  const key = await readPrivateKey(flags.key, io);
  if (!key) return 2;

  let change: KeyChange;
  if (kind === "genesis") {
    let reviewers: unknown;
    try {
      reviewers = JSON.parse(await io.readText(flags.genesis));
    } catch (error) {
      io.log(`Cannot read the reviewers in ${flags.genesis}: ${describeError(error)}`);
      return 2;
    }
    change = { type: "genesis", reviewers: reviewers as never };
    const named = Array.isArray(reviewers)
      ? reviewers.find(r => isRecord(r) && r.reviewer_id === flags.signer)
      : undefined;
    if (!isRecord(named) || named.public_key !== key.publicKey) {
      io.log(
        `This key is not the key the genesis names for ${flags.signer}. Nothing signed.`
      );
      return 2;
    }
  } else if (kind === "add") {
    change = {
      type: kind,
      reviewer_id: flags.add,
      name: flags.name,
      public_key: flags["public-key"],
    };
  } else if (kind === "rotate") {
    change = {
      type: kind,
      reviewer_id: flags.rotate,
      public_key: flags["public-key"],
    };
  } else {
    change = { type: kind, reviewer_id: flags[kind] };
  }

  const record = signKeyRecord(
    {
      schema: REVIEWER_KEY_SCHEMA,
      signer_id: flags.signer,
      change,
      ...(flags.reason !== undefined ? { reason: flags.reason } : {}),
      decided_at: io.now().toISOString(),
    },
    key.privateKeyPem
  );
  const form = checkKeyRecordForm(record);
  if (!form.ok) {
    io.log(`Not signed: ${form.reason}.`);
    return 2;
  }
  const code = await writeRecord(flags.out, record, io);
  if (code === 0 && change.type === "genesis") {
    io.log(
      `Genesis hash: ${genesisHash(change.reviewers)}. Every reviewer it names should see the same. The Bureau counts this genesis only once REVIEW_GENESIS in server/reviewLog.ts is set to it, by pull request.`
    );
  }
  return code;
}

// The active keys server/furnishers.ts lists for a furnisher, sorted by key_id.
function listedKeys(furnisher: Furnisher): AdmittedKey[] {
  return Object.entries(furnisher.keys)
    .filter(([, k]) => k.status === "active")
    .map(([key_id, k]) => ({ key_id, public_key: k.publicKey }))
    .sort((a, b) => (a.key_id < b.key_id ? -1 : 1));
}

// Signs an admission or revocation, checks its form and writes it for pnpm review submit.
async function writeAdmission(
  unsigned: UnsignedAdmission,
  keyFile: string,
  out: string,
  io: ReviewIO
): Promise<number> {
  const key = await readPrivateKey(keyFile, io);
  if (!key) return 2;
  const record = signAdmission(unsigned, key.privateKeyPem);
  const form = checkAdmissionForm(record);
  if (!form.ok) {
    io.log(`Not signed: ${form.reason}.`);
    return 2;
  }
  return writeRecord(out, record, io);
}

async function admitCommand(args: string[], io: ReviewIO): Promise<number> {
  const flags = readFlags(args);
  const required = ["key", "reviewer", "furnisher", "out"];
  const optional = ["probation-days", "org", "furnisher-key"];
  if (
    !flags ||
    Object.keys(flags).some(name => !required.includes(name) && !optional.includes(name)) ||
    required.some(name => !flags[name])
  ) {
    io.log(USAGE);
    return 2;
  }
  const furnishers = io.furnishers ?? FURNISHERS;
  const listed = Object.hasOwn(furnishers, flags.furnisher) ? furnishers[flags.furnisher] : undefined;
  let orgId: string;
  let keys: AdmittedKey[];
  if (listed) {
    if (flags.org !== undefined || flags["furnisher-key"] !== undefined) {
      io.log(
        `${flags.furnisher} is listed in server/furnishers.ts, so its organization and active keys are taken from there; --org and --furnisher-key are for an unlisted furnisher.`
      );
      return 2;
    }
    orgId = listed.counterauditOrgId;
    keys = listedKeys(listed);
    if (keys.length === 0) {
      io.log(`${flags.furnisher} has no active key in server/furnishers.ts. Nothing signed.`);
      return 2;
    }
  } else {
    const named = flags["furnisher-key"] ?? "";
    const eq = named.indexOf("=");
    if (flags.org === undefined || eq < 1) {
      io.log(
        `${flags.furnisher} is not listed in server/furnishers.ts: name the organization it seals in with --org and its signing key with --furnisher-key <key_id>=<ed25519:...>.`
      );
      return 2;
    }
    orgId = flags.org;
    keys = [{ key_id: named.slice(0, eq), public_key: named.slice(eq + 1) }];
  }
  const days = flags["probation-days"] ?? String(MIN_PROBATION_DAYS);
  if (!/^[0-9]{1,3}$/.test(days)) {
    io.log(`--probation-days must be a whole number from ${MIN_PROBATION_DAYS} to ${MAX_PROBATION_DAYS}.`);
    return 2;
  }
  io.log(
    [
      `Admitting ${flags.furnisher}: you attest it was vetted and deals at arm's length with the subjects it reports on.`,
      `  organization ${orgId}`,
      ...keys.map(k => `  key ${k.key_id} ${k.public_key}`),
      `  probation ${days} days from when the second reviewer's admission is sealed`,
      "It is admitted once a second reviewer seals an admission naming the same organization and keys.",
    ].join("\n")
  );
  return writeAdmission(
    {
      schema: ADMISSION_SCHEMA,
      reviewer_id: flags.reviewer,
      furnisher_id: flags.furnisher,
      decision: "admit",
      counteraudit_org_id: orgId,
      keys,
      arms_length: true,
      probation_days: Number(days),
      decided_at: io.now().toISOString(),
    },
    flags.key,
    flags.out,
    io
  );
}

async function revokeAdmissionCommand(args: string[], io: ReviewIO): Promise<number> {
  const flags = readFlags(args);
  const required = ["key", "reviewer", "furnisher", "reason", "out"];
  if (
    !flags ||
    Object.keys(flags).some(name => !required.includes(name)) ||
    required.some(name => !flags[name])
  ) {
    io.log(USAGE);
    return 2;
  }
  io.log(
    `Revoking ${flags.furnisher}'s admission: once sealed, none of its live lines is released until two reviewers admit it again.`
  );
  return writeAdmission(
    {
      schema: ADMISSION_SCHEMA,
      reviewer_id: flags.reviewer,
      furnisher_id: flags.furnisher,
      decision: "revoke",
      reason: flags.reason,
      decided_at: io.now().toISOString(),
    },
    flags.key,
    flags.out,
    io
  );
}

async function submit(args: string[], io: ReviewIO): Promise<number> {
  if (args.length !== 1) {
    io.log(USAGE);
    return 2;
  }
  if (!ENV.counterauditReviewIngestKey) {
    io.log(
      "Not set: COUNTERAUDIT_REVIEW_INGEST_KEY, your own ingest key to the review organization. See docs/two-person-review.md."
    );
    return 2;
  }
  let record: unknown;
  try {
    record = JSON.parse(await io.readText(args[0]));
  } catch (error) {
    io.log(`Cannot read one JSON record in ${args[0]}: ${describeError(error)}`);
    return 2;
  }
  if (
    !isRecord(record) ||
    (record.schema !== REVIEW_SCHEMA &&
      record.schema !== REVIEWER_KEY_SCHEMA &&
      record.schema !== ADMISSION_SCHEMA)
  ) {
    io.log(
      `${args[0]} holds no review decision, reviewer-key record or furnisher admission. Nothing sealed.`
    );
    return 2;
  }
  let sealed: Awaited<ReturnType<typeof submitReviewRecord>>;
  try {
    sealed = await submitReviewRecord(record, {
      apiUrl: ENV.counterauditApiUrl,
      ingestKey: ENV.counterauditReviewIngestKey,
      fetch: io.fetch,
    });
  } catch (error) {
    io.log(`Not sealed: ${describeError(error)}.`);
    return 2;
  }
  if (!sealed.ok) {
    io.log(`Not sealed: ${sealed.reason}.`);
    return 1;
  }
  io.log(
    `${sealed.created ? "Sealed" : "Already sealed"} in the review log: packet ${sealed.packetId}${sealed.sequence === null ? "" : `, sequence ${sealed.sequence}`}. Once the operator syncs, pnpm review queue lists it there.`
  );
  // CounterAudit's signed receipt, the reviewer's proof of where it was sealed.
  const receiptFile = `${args[0]}.receipt.json`;
  const receipt = `${JSON.stringify(sealed.receipt, null, 2)}\n`;
  try {
    await io.writeNewFile(receiptFile, receipt);
    io.log(`Receipt written to ${receiptFile}. Keep it.`);
  } catch (error) {
    io.log(`Cannot write ${receiptFile} (${describeError(error)}). The receipt, to keep:\n${receipt}`);
  }
  return 0;
}

// Control, format and line-separator characters (an escape sequence, a bidi override) could
// make the description below say something other than what is signed, so a request holding
// any is refused.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
function hasHidden(value: unknown): boolean {
  if (typeof value === "string") return HIDDEN.test(value);
  if (Array.isArray(value)) return value.some(hasHidden);
  if (isRecord(value)) {
    return Object.entries(value).some(([k, v]) => HIDDEN.test(k) || hasHidden(v));
  }
  return false;
}

// What an approval request asks for, in words, so the reviewer sees what they sign. Every
// value is shown as JSON, quoted.
function describeRequest(
  operation: ApprovableOperation,
  payload: Record<string, unknown>
): string {
  const q = (value: unknown) => JSON.stringify(value ?? null);
  switch (operation) {
    case "create_key":
      return `create a key with role ${q(payload.role ?? "admin")}, labelled ${q(payload.label ?? "api")}, expiring in ${q(payload.expires_in_days ?? "the default number of")} days`;
    case "revoke_key":
      return payload.key_prefix === undefined
        ? `revoke key ${q(payload.key_id)}, which CounterAudit did not find in this organization`
        : `revoke key ${q(payload.key_id)}: role ${q(payload.role)}, labelled ${q(payload.label)}, prefix ${q(payload.key_prefix)}`;
    case "set_review_org":
      return typeof payload.genesis_hash === "string"
        ? `treat this organization as the review organization, counting only genesis ${q(payload.genesis_hash)}`
        : "stop treating this organization as the review organization";
  }
}

// Signs a reviewer's approval of one CounterAudit approval request in the review
// organization: the request as GET /v1/admin/keys/requests/:id returns it, which
// the operator hands over. The signature covers the request's id, organization,
// operation and payload, so it approves that request and nothing else.
async function approveKeyCommand(args: string[], io: ReviewIO): Promise<number> {
  const flags = readFlags(args);
  const required = ["key", "reviewer", "request", "out"];
  if (
    !flags ||
    Object.keys(flags).some(name => !required.includes(name)) ||
    required.some(name => !flags[name])
  ) {
    io.log(USAGE);
    return 2;
  }
  let request: unknown;
  try {
    request = JSON.parse(await io.readText(flags.request));
  } catch (error) {
    io.log(`Cannot read the approval request in ${flags.request}: ${describeError(error)}`);
    return 2;
  }
  if (
    !isRecord(request) ||
    typeof request.id !== "string" ||
    typeof request.org_id !== "string" ||
    !isRecord(request.payload)
  ) {
    io.log(
      `${flags.request} is not an approval request as GET /v1/admin/keys/requests/:id returns it. Nothing signed.`
    );
    return 2;
  }
  if (!APPROVABLE_OPERATIONS.includes(request.operation as ApprovableOperation)) {
    io.log(
      `A reviewer approves only ${APPROVABLE_OPERATIONS.join(", ")}; this request is ${String(request.operation)}. Nothing signed.`
    );
    return 2;
  }
  if (request.status !== undefined && request.status !== "pending") {
    io.log(`The request is ${String(request.status)}, not pending. Nothing signed.`);
    return 2;
  }
  if (hasHidden(request.payload)) {
    io.log(
      "The request holds control or formatting characters, which could hide what it does. Nothing signed; ask the operator for a request without them."
    );
    return 2;
  }
  const reviewOrg = ENV.counterauditReviewOrgId;
  if (reviewOrg && request.org_id !== reviewOrg) {
    io.log(
      `The request is for organization ${JSON.stringify(request.org_id)}, not the review organization ${reviewOrg}. Nothing signed.`
    );
    return 2;
  }
  const key = await readPrivateKey(flags.key, io);
  if (!key) return 2;
  const operation = request.operation as ApprovableOperation;
  const approval = signKeyApproval(
    {
      schema: KEY_APPROVAL_SCHEMA,
      reviewer_id: flags.reviewer,
      org_id: request.org_id,
      request_id: request.id,
      operation,
      payload_sha256: payloadDigest(request.payload),
      decided_at: io.now().toISOString(),
    },
    key.privateKeyPem
  );
  const form = checkKeyApprovalForm(approval);
  if (!form.ok || !keyApprovalVerifies(form.approval, key.publicKey)) {
    io.log(`Not signed: ${form.ok ? "the signature does not check" : form.reason}.`);
    return 2;
  }
  const needed = request.reviewer_approvals_required;
  io.log(
    `Approving request ${request.id} in organization ${request.org_id}: ${describeRequest(operation, request.payload)}.${typeof needed === "number" && needed > 1 ? ` It runs once ${needed} different reviewers approve it.` : ""}${reviewOrg ? "" : " COUNTERAUDIT_REVIEW_ORG_ID is not set here, so the organization was not checked."}`
  );
  return writeRecord(
    flags.out,
    approval,
    io,
    `Give it to the operator, who sends it to CounterAudit (POST /v1/admin/keys/requests/${request.id}/reviewer-approval). It approves this request only.`
  );
}

async function needDatabase(io: ReviewIO): Promise<boolean> {
  if (!ENV.databaseUrl) {
    io.log("Not set: DATABASE_URL. See docs/two-person-review.md.");
    return false;
  }
  if (!(await schemaReady())) {
    io.log(
      "The database is not reachable or lacks the outcome tables. Start the server once so it applies migrations (or run pnpm db:migrate), then try again."
    );
    return false;
  }
  return true;
}

/** Who the review log says the reviewers are, for the operator and the reviewers. */
function describeLog(log: ReviewLog): string[] {
  const read =
    log.readTo === null
      ? "The review log is empty here: run pnpm review sync."
      : `Review log read to sequence ${log.readTo}.`;
  if (!log.reviewers) {
    return [
      read,
      `No genesis has taken effect, so no decision counts.${REVIEW_GENESIS ? "" : " None is pinned yet (REVIEW_GENESIS in server/reviewLog.ts)."}`,
    ];
  }
  const reviewers = [...log.reviewers.entries()]
    .filter(([, r]) => r.status !== "removed")
    .map(([id, r]) => `${id} (${r.name}) ${r.status}`);
  return [
    read,
    `Reviewers: ${reviewers.join(", ") || "none"}.`,
    ...(log.testnet
      ? ["These are the operator-held testnet reviewers: only decisions on test data count, and no live line is released."]
      : []),
  ];
}

/** Whether a live line's furnisher is admitted, for the queue. */
function describeGate(gate: AdmissionGate): string {
  if (!gate.admitted) return `not admitted for this line: ${gate.problem}`;
  return gate.onProbation
    ? `admitted, and the line was sealed during its probation${gate.probationUntil ? ` (until ${gate.probationUntil.toISOString()})` : ""}: no approval can waive anything for it`
    : "admitted, and the line was sealed after its probation";
}

/** Each furnisher's admission as the review log stands (server/furnisherAdmission.ts). */
async function admissionsCommand(io: ReviewIO): Promise<number> {
  if (!(await needDatabase(io))) return 2;
  const log = await loadReviewLog();
  for (const line of describeLog(log)) io.log(line);
  if (log.testnet) {
    io.log("Admissions do not count under the testnet genesis.");
    return 0;
  }
  if (log.admissions.size === 0) {
    io.log("No furnisher is admitted, so no live line is released. See pnpm review admit.");
    return 0;
  }
  const now = io.now();
  for (const [furnisherId, state] of [...log.admissions.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const admitted = state.admitted;
    io.log(
      admitted
        ? `${furnisherId}: admitted at sequence ${admitted.sequence} by ${admitted.by.join(" and ")}, since ${admitted.since.toISOString()}; ${admitted.probationUntil.getTime() > now.getTime() ? "on probation until" : "probation ended"} ${admitted.probationUntil.toISOString()}`
        : state.revoked
          ? `${furnisherId}: revoked at sequence ${state.revoked.sequence} by ${state.revoked.by}: ${JSON.stringify(state.revoked.reason)}`
          : `${furnisherId}: not admitted`
    );
    if (admitted) {
      io.log(`  organization ${admitted.orgId}`);
      for (const k of admitted.keys) io.log(`  key ${k.key_id} ${k.public_key}`);
    }
    for (const vote of state.pending) {
      io.log(
        `  waiting for a second reviewer: ${vote.by.join(", ")} admitted organization ${vote.orgId} with ${vote.keys.map(k => k.key_id).join(", ")}`
      );
    }
  }
  return 0;
}

export const PAYMENT_OUTCOMES = new Set(["paid", "refunded", "payment_failed"]);

/**
 * What a line's evidence proved, by the names decided for review finding M-04
 * (docs/independent-payer.md): a verified payment proves a transfer settled, not
 * who controls the payer. The stored evidence status stays `verified`; files
 * use these names (server/agentFile.ts).
 */
export function evidenceLabel(outcome: string, status: string | null): string {
  if (status !== "verified") return status ?? "not checked";
  if (outcome === "payment_failed") return "payment_failure_verified";
  return PAYMENT_OUTCOMES.has(outcome) ? "payment_settlement_verified" : "verified";
}

/** The funding screen's result and why, for the queue. */
function describeScreen(screen: unknown): string {
  if (!isRecord(screen) || typeof screen.result !== "string") return "not run";
  const reasons = [
    ...(Array.isArray(screen.flags) ? screen.flags : []),
    ...(Array.isArray(screen.gaps) ? screen.gaps : []),
  ].map(String);
  return `${screen.result}${reasons.length ? `: ${reasons.join("; ")}` : ""}`;
}

// A sync older than this leaves the queue's view of the review log stale.
const SYNC_STALE_MS = 24 * 3_600_000;

/**
 * Where the operator's copy of the review log stands against CounterAudit, from the last
 * pnpm review sync: how far it is read, the head CounterAudit listed, the last sync that read
 * the whole log, and whether the copy is stopped at a problem, behind or stale. File assembly
 * reads the log to its head itself (review M-01), so this is the operator's view, not a gate.
 */
async function describeSync(log: ReviewLog, now: Date): Promise<string[]> {
  const sync = await getReviewLogSync();
  const held = log.readTo === null ? 0 : log.readTo + 1;
  const org = sync?.orgId ? [`Review organization: ${sync.orgId}.`] : [];
  const when = (at: Date) => {
    const hours = Math.floor((now.getTime() - at.getTime()) / 3_600_000);
    return `${at.toISOString()} (${hours < 1 ? "under an hour" : `${hours} hour${hours === 1 ? "" : "s"}`} ago)`;
  };
  if (!sync) return ["Sync status: no pnpm review sync has run yet."];
  const out = [
    `Sync status: last run ${when(sync.lastAttemptAt)}; last that read the whole log ${sync.lastSuccessAt ? when(sync.lastSuccessAt) : "never"}.`,
    sync.listedCount === null || !sync.listedAt
      ? "CounterAudit's head: no complete listing recorded yet."
      : `CounterAudit's head: ${sync.listedCount} packet${sync.listedCount === 1 ? "" : "s"} listed${sync.listedCount > 0 ? ` (sequence ${sync.listedCount - 1})` : ""} at ${sync.listedAt.toISOString()}; ${held} held here.`,
  ];
  if (sync.problem) out.push(`STOPPED at the last sync: ${sync.problem}. Nothing past it counts until it is resolved.`);
  if (sync.listedCount !== null && sync.listedCount > held) {
    out.push(`BEHIND: ${sync.listedCount - held} listed packet${sync.listedCount - held === 1 ? "" : "s"} not read here.`);
  }
  if (!sync.lastSuccessAt || now.getTime() - sync.lastSuccessAt.getTime() > SYNC_STALE_MS) {
    out.push("STALE: no sync has read the whole log in the last 24 hours; run pnpm review sync.");
  }
  if (out.length === 2) out.push("Up to date as of the last sync.");
  return [...org, ...out];
}

/**
 * The queue's lines for a line's subject disputes (docs/disputes.md): each open dispute with its
 * deadline, each lapsed one, and each open appeal with what decides it. Confirmed, corrected and
 * withdrawn disputes with no open appeal wait on no one.
 */
function describeDisputes(line: Line, disputes: Dispute[]): string[] {
  const ref = `${line.furnisherId}/${line.eventId}`;
  const out: string[] = [];
  for (const d of disputes) {
    const id = `dispute ${d.disputeId} on ${ref}`;
    if (d.state === "open") {
      out.push(`  ${id}: open since ${d.filedAt.toISOString()}; the furnisher must answer by ${d.respondBy.toISOString()}`);
    } else if (d.state === "lapsed") {
      out.push(`  ${id}: lapsed at ${d.respondBy.toISOString()} without an answer from ${line.furnisherId}; the line is removed`);
    }
    const appeal = d.appeal;
    if (appeal?.state === "open") {
      out.push(
        appeal.party === "subject"
          ? `  ${id}: the subject's appeal, sealed ${appeal.sealedAt.toISOString()} (packet ${appeal.packetId}), is open: a reviewer's rejection of ${ref} upholds it, and the approvals a release needs dismiss it, counting decisions sealed after the appeal`
          : `  ${id}: the furnisher's appeal, sealed ${appeal.sealedAt.toISOString()} (packet ${appeal.packetId}), is open: releasing its correction ${line.furnisherId}/${appeal.correctiveEventId} upholds it, and a rejection of that line dismisses it, counting decisions sealed after the appeal; ${ref} stays removed either way`
      );
    }
  }
  return out;
}

async function queue(io: ReviewIO) {
  if (!(await needDatabase(io))) return 2;
  const log = await loadReviewLog();
  const now = io.now();
  for (const line of describeLog(log)) io.log(line);
  for (const line of await describeSync(log, now)) io.log(line);
  const lines = await listOutcomeLines();
  let waiting = 0;
  let released = 0;
  let closed = 0;
  let expired = 0;
  let removed = 0;
  const disputeLines: string[] = [];
  const tally = { open: 0, lapsed: 0, appeals: 0 };
  for (const line of lines) {
    // Erased with its source (pnpm lines expire): nothing is left to review.
    if (line.expiredAt) {
      expired++;
      continue;
    }
    const relating = await findRelatingOutcomeLines(
      line.furnisherId,
      line.eventId
    );
    const reviews = reviewsFor(line, log);
    const admission = admissionFor(line, log, io.furnishers);
    const checked = await checkLineDisputes(line);
    const disputes = deriveDisputes({
      line,
      records: checked.checkedDisputes,
      relating,
      reviewsOf: l => reviewsFor(l, log),
      now,
      admissionOf: l => admissionFor(l, log, io.furnishers),
    });
    disputeLines.push(...describeDisputes(line, disputes));
    for (const d of disputes) {
      if (d.state === "open") tally.open++;
      if (d.state === "lapsed") tally.lapsed++;
      if (d.appeal?.state === "open") tally.appeals++;
    }
    const states = lineStates(
      line,
      relating,
      reviews,
      currentDispute(disputes)?.state ?? null,
      admission
    );
    // Removed after a lapsed subject dispute: it can never be released again.
    if (states.removed) {
      removed++;
      continue;
    }
    if (states.withdrawn || states.superseded) {
      closed++;
      continue;
    }
    const release = releaseFor(line, reviews, admission);
    if (release.released) released++;
    else waiting++;
    const evidence = isRecord(line.evidenceResult) ? line.evidenceResult : {};
    const reasons = Array.isArray(evidence.reasons)
      ? evidence.reasons.join("; ")
      : "";
    const sealed = log.decisions.filter(
      d =>
        d.decision.furnisher_id === line.furnisherId &&
        d.decision.event_id === line.eventId
    );
    io.log(
      [
        `${line.furnisherId}/${line.eventId}  ${line.outcome}  ${line.dataClass} data  shown ${line.displayState}`,
        `  hash ${line.signedEventHash}`,
        `  proof ${line.proofOk ? "passed" : "not passed"}; evidence ${evidenceLabel(line.outcome, signedEvidenceStatus(line))}${reasons ? `: ${reasons}` : ""}`,
        // Live data needs its furnisher admitted by two reviewers (pnpm review admissions).
        ...(line.dataClass === "live" ? [`  furnisher ${describeGate(admission)}`] : []),
        // Subject control is Phase 3, so it is unproven for every line
        // (docs/independent-payer.md, layers 2 and 3).
        ...(PAYMENT_OUTCOMES.has(line.outcome)
          ? [
              `  subject_control unproven; payer_independence_screen ${describeScreen(evidence.funding_screen)}`,
              "  check: a settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered; reject if you judge the payer related to the furnisher",
            ]
          : []),
        // Every decision the log holds for this line, so a reviewer can find
        // their own by its packet.
        ...sealed.map(
          d =>
            `  sealed: ${d.decision.reviewer_id} ${d.decision.decision} at sequence ${d.sequence} (packet ${d.packetId})${d.suspended ? ", by a suspended reviewer" : ""}`
        ),
        release.released
          ? `  released (${release.released === "solo_test" ? "one reviewer, test data" : "two reviewers"})`
          : `  review: ${release.holdingBack}`,
        `  sign with: --line ${line.furnisherId}/${line.eventId} --hash ${line.signedEventHash} --data-class ${line.dataClass} --evidence ${evidenceDigest(line.evidenceResult)}`,
      ].join("\n")
    );
  }
  io.log(
    `${lines.length} line${lines.length === 1 ? "" : "s"}: ${waiting} waiting, ${released} released, ${closed} withdrawn or superseded${removed ? `, ${removed} removed after a lapsed dispute` : ""}${expired ? `, ${expired} expired with their source` : ""}.`
  );
  if (disputeLines.length > 0) {
    io.log("Subject disputes (docs/disputes.md):");
    for (const line of disputeLines) io.log(line);
    io.log(
      `${tally.open} open, ${tally.lapsed} lapsed, ${tally.appeals} appeal${tally.appeals === 1 ? "" : "s"} open.`
    );
  }
  return 0;
}

// Re-settles every line against the review log, and its subject disputes as of now.
async function settleEvery(io: ReviewIO, log: ReviewLog) {
  const lines = await listOutcomeLines();
  const now = io.now();
  let changes = 0;
  for (const line of lines) {
    const changed = await settle(line, log, now);
    if (changed) {
      changes++;
      io.log(
        `${line.furnisherId}/${line.eventId}: ${line.displayState} -> ${changed}`
      );
    }
  }
  io.log(
    `${lines.length} line${lines.length === 1 ? "" : "s"} settled, ${changes} changed.`
  );
}

async function settleAll(io: ReviewIO) {
  if (!(await needDatabase(io))) return 2;
  await settleEvery(io, await loadReviewLog());
  return 0;
}

// Reads the review log's new packets with the Bureau's read key, stores them
// and settles every line. Exits 1 when it stopped at a problem; what it read
// before the problem is kept.
async function sync(io: ReviewIO) {
  const missing = [
    ["COUNTERAUDIT_REVIEW_ORG_ID", ENV.counterauditReviewOrgId],
    ["COUNTERAUDIT_REVIEW_READ_KEY", ENV.counterauditReviewReadKey],
  ].filter(([, value]) => !value);
  if (missing.length) {
    io.log(
      `Not set: ${missing.map(([name]) => name).join(", ")}. See docs/two-person-review.md.`
    );
    return 2;
  }
  if (!(await needDatabase(io))) return 2;
  let result: Awaited<ReturnType<typeof readReviewLog>>;
  try {
    const wrongOrg = await reviewLogOrgProblem(ENV.counterauditReviewOrgId);
    result = wrongOrg
      ? { rows: [], listed: 0, listedComplete: false, problem: wrongOrg, checkpoint: null }
      : await readReviewLog({
          apiUrl: ENV.counterauditApiUrl,
          readKey: ENV.counterauditReviewReadKey,
          orgId: ENV.counterauditReviewOrgId,
          known: await listReviewLogRecords(),
          // Not below the newest signed checkpoint any read has reached (review AB-01).
          minHead: await getReviewLogHead(),
          fetch: io.fetch,
          now: io.now(),
        });
  } catch (error) {
    io.log(`Could not read the review log: ${describeError(error)}.`);
    await recordReviewLogSync({ at: io.now(), problem: `could not read the review log: ${describeError(error)}`, listedCount: null });
    return 2;
  }
  const added = await insertReviewLogRecords(result.rows, ENV.counterauditReviewOrgId);
  await recordReviewLogSync({
    at: io.now(),
    problem: result.problem,
    listedCount: result.listedComplete ? result.listed : null,
  });
  // Recorded even when the read stopped: a signed head the log did not reach is one the next read must.
  if (result.checkpoint) {
    await recordReviewLogCheckpoint(result.checkpoint, io.now(), {
      orgId: ENV.counterauditReviewOrgId,
      whole: result.problem === null,
    });
  }
  if (!result.problem) await bindReviewLogOrg(ENV.counterauditReviewOrgId, io.now());
  const fresh = new Set(result.rows.map(r => r.sequence));
  const log = await loadReviewLog();
  io.log(`Read ${added} new packet${added === 1 ? "" : "s"}.`);
  for (const event of log.events) {
    if (fresh.has(event.sequence)) {
      io.log(`  sequence ${event.sequence}: ${event.text}`);
    }
  }
  for (const line of describeLog(log)) io.log(line);
  if (result.problem) {
    io.log(
      `Stopped: ${result.problem}. Nothing past it counts until it is resolved.`
    );
  }
  await settleEvery(io, log);
  return result.problem ? 1 : 0;
}

/**
 * pnpm review move: replaces the Bureau's copy of the review log with the whole log of the pinned
 * organization, for a new genesis in a review organization of its own (docs/two-person-review.md).
 * It goes only to REVIEW_ORG_ID, and only from a log the pinned genesis does not count in to one it
 * does. So every move rests on a public pull request naming both, and a log cannot be swapped for
 * a copy of it that leaves out a decision. A return to an organization is held to the head the copy
 * had reached there.
 */
async function moveCommand(io: ReviewIO): Promise<number> {
  const missing = [
    ["COUNTERAUDIT_REVIEW_ORG_ID", ENV.counterauditReviewOrgId],
    ["COUNTERAUDIT_REVIEW_READ_KEY", ENV.counterauditReviewReadKey],
  ].filter(([, value]) => !value);
  if (missing.length) {
    io.log(`Not set: ${missing.map(([name]) => name).join(", ")}. See docs/two-person-review.md.`);
    return 2;
  }
  if (!(await needDatabase(io))) return 2;
  const to = ENV.counterauditReviewOrgId;
  const notPinned = pinnedOrgProblem(to);
  if (notPinned) {
    io.log(`Not moved: ${notPinned}.`);
    return 1;
  }
  const from = (await getReviewLogSync())?.orgId ?? null;
  if (from === to) {
    io.log(`The Bureau's copy of the review log is already organization ${to}'s. Nothing to move: run pnpm review sync.`);
    return 1;
  }
  const packets = (await listReviewLogRecords()).length;
  if (from === null && packets > 0) {
    io.log(
      "Not moved: no organization is recorded for the log held here, so the head it reached could not be kept. Run pnpm review sync from the deployment that pins that organization, which records it."
    );
    return 1;
  }
  if ((await loadReviewLog()).reviewers) {
    io.log(
      `Not moved: the pinned genesis has taken effect in the log held here. A move needs a new genesis: change REVIEW_GENESIS and REVIEW_ORG_ID by pull request first, so a log cannot be swapped for one that leaves out a decision.`
    );
    return 1;
  }
  let target: Awaited<ReturnType<typeof readReviewLogNow>>;
  try {
    target = await readReviewLogNow({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReviewReadKey,
      orgId: to,
      minHead: await getReviewLogMoveHead(to),
      fetch: io.fetch,
      now: io.now(),
    });
  } catch (error) {
    target = { problem: describeError(error) };
  }
  if ("problem" in target) {
    io.log(`Not moved: organization ${to}'s review log could not be read whole: ${target.problem}.`);
    return 1;
  }
  if (!target.log.reviewers) {
    io.log(
      `Not moved: the pinned genesis has not taken effect in organization ${to}'s review log. Every reviewer it names must seal it there first.`
    );
    return 1;
  }
  try {
    await moveReviewLog({
      expected: { orgId: from, packets },
      toOrgId: to,
      rows: target.rows,
      checkpoint: target.checkpoint,
      pinnedGenesis: REVIEW_GENESIS,
      at: io.now(),
    });
  } catch (error) {
    io.log(`Not moved: ${describeError(error)}. Run it again with no other review run going.`);
    return 1;
  }
  io.log(`Moved the Bureau's copy of the review log ${from ? `from organization ${from} ` : ""}to ${to}. Its ${target.rows.length} packet${target.rows.length === 1 ? "" : "s"} are read.`);
  const head = target.position;
  if (head) {
    io.log(`Its head is sequence ${head.sequence}. Set COUNTERAUDIT_REVIEW_MIN_HEAD to ${head.sequence}:${head.entryHash} wherever pnpm file verify --current runs.`);
  }
  for (const line of describeLog(target.log)) io.log(line);
  await settleEvery(io, target.log);
  return 0;
}

/**
 * pnpm review head: CounterAudit's signed checkpoint for the review log, checked against its pinned
 * export key, beside the newest the Bureau has recorded and a head given in
 * COUNTERAUDIT_REVIEW_MIN_HEAD. A reviewer runs it with their own read key and compares it with the
 * sequence in their latest receipt: CounterAudit's head at or past it, and the Bureau's recorded one
 * not behind, is the review log as the reviewer knows it. Where the Bureau's organization can be
 * read too, its signed head, beside COUNTERAUDIT_MIN_HEAD: pnpm file verify --current holds each to
 * its pin. Exits 1 when a head went back or a check failed.
 */
async function headCommand(io: ReviewIO): Promise<number> {
  const missing = [
    ["COUNTERAUDIT_REVIEW_ORG_ID", ENV.counterauditReviewOrgId],
    ["COUNTERAUDIT_REVIEW_READ_KEY", ENV.counterauditReviewReadKey],
  ].filter(([, value]) => !value);
  if (missing.length) {
    io.log(`Not set: ${missing.map(([name]) => name).join(", ")}. See docs/two-person-review.md.`);
    return 2;
  }
  const pinned = ENV.counterauditReviewMinHead ? parseHead(ENV.counterauditReviewMinHead) : null;
  if (ENV.counterauditReviewMinHead && !pinned) {
    io.log('COUNTERAUDIT_REVIEW_MIN_HEAD is not "sequence:entryhash".');
    return 2;
  }
  const orgPinned = ENV.counterauditMinHead ? parseHead(ENV.counterauditMinHead) : null;
  if (ENV.counterauditMinHead && !orgPinned) {
    io.log('COUNTERAUDIT_MIN_HEAD is not "sequence:entryhash".');
    return 2;
  }
  const notPinned = pinnedOrgProblem(ENV.counterauditReviewOrgId);
  if (notPinned) {
    io.log(`Stopped: ${notPinned}.`);
    return 1;
  }
  let read: Awaited<ReturnType<typeof readCheckpoint>>;
  try {
    read = await readCheckpoint({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReviewReadKey,
      orgId: ENV.counterauditReviewOrgId,
      fetch: io.fetch,
    });
  } catch (error) {
    io.log(`Could not read the checkpoint: ${describeError(error)}.`);
    return 2;
  }
  if (!read.ok) {
    io.log(`Stopped: ${read.problem}.`);
    return 1;
  }
  const cp = read.head;
  io.log(
    cp
      ? `CounterAudit's signed head: sequence ${cp.sequence}, entry hash ${cp.entryHash}, packet ${cp.packetId}, issued ${cp.issuedAt.toISOString()}. Signature checked against the pinned export key, and attested as the head now over this read's own nonce.`
      : "CounterAudit's signed head: none yet, attested over this read's own nonce: the review log has no numbered packet."
  );
  let failed = false;
  // A database that is set but not ready is a comparison not made, not a head not recorded yet.
  const ready = await schemaReady().catch(() => false);
  if (!ready && ENV.databaseUrl) {
    io.log("NOT CHECKED: DATABASE_URL is set, but the Bureau's recorded head could not be read (the database is not ready).");
    failed = true;
  }
  const wrongOrg = ready ? await reviewLogOrgProblem(ENV.counterauditReviewOrgId) : null;
  if (wrongOrg) {
    io.log(`NOT CHECKED: ${wrongOrg}.`);
    failed = true;
  }
  const recorded = ready && !wrongOrg ? await getReviewLogHead() : null;
  if (recorded) {
    io.log(`The Bureau's recorded head: sequence ${recorded.sequence}, entry hash ${recorded.entryHash}.`);
    if (!cp || cp.sequence < recorded.sequence) {
      io.log("WENT BACK: CounterAudit's head is below the one the Bureau has already reached.");
      failed = true;
    } else if (cp.sequence === recorded.sequence && cp.entryHash !== recorded.entryHash) {
      io.log("DIFFERS: CounterAudit's head names another packet at the sequence the Bureau recorded.");
      failed = true;
    }
  } else if (!failed) {
    io.log("The Bureau's recorded head: none (no database here, or no read has reached a checkpoint yet).");
  }
  if (pinned) {
    if (!cp || cp.sequence < pinned.sequence) {
      io.log(`BEHIND: CounterAudit's head is below COUNTERAUDIT_REVIEW_MIN_HEAD (sequence ${pinned.sequence}).`);
      failed = true;
    } else if (cp.sequence === pinned.sequence && cp.entryHash !== pinned.entryHash) {
      io.log(`DIFFERS: CounterAudit's head names another packet at sequence ${pinned.sequence} than COUNTERAUDIT_REVIEW_MIN_HEAD.`);
      failed = true;
    } else {
      io.log(`At or past COUNTERAUDIT_REVIEW_MIN_HEAD (sequence ${pinned.sequence}). pnpm file verify --current checks the packet there too.`);
    }
  }
  if (ENV.counterauditOrgId && ENV.counterauditReadKey) {
    let org: Awaited<ReturnType<typeof readCheckpoint>>;
    try {
      org = await readCheckpoint({
        apiUrl: ENV.counterauditApiUrl,
        readKey: ENV.counterauditReadKey,
        orgId: ENV.counterauditOrgId,
        fetch: io.fetch,
        of: "the Bureau organization",
      });
    } catch (error) {
      io.log(`Could not read the Bureau organization's checkpoint: ${describeError(error)}.`);
      return 2;
    }
    if (!org.ok) {
      io.log(`Stopped: ${org.problem}.`);
      return 1;
    }
    const head = org.head;
    io.log(
      head
        ? `The Bureau organization's signed head: sequence ${head.sequence}, entry hash ${head.entryHash}. Signature and head attestation checked against CounterAudit's pinned export key.`
        : "The Bureau organization's signed head: none yet, attested over this read's own nonce."
    );
    if (orgPinned) {
      if (!head || head.sequence < orgPinned.sequence) {
        io.log(`BEHIND: the Bureau organization's head is below COUNTERAUDIT_MIN_HEAD (sequence ${orgPinned.sequence}).`);
        failed = true;
      } else if (head.sequence === orgPinned.sequence && head.entryHash !== orgPinned.entryHash) {
        io.log(`DIFFERS: the Bureau organization's head names another packet at sequence ${orgPinned.sequence} than COUNTERAUDIT_MIN_HEAD.`);
        failed = true;
      } else {
        io.log(`At or past COUNTERAUDIT_MIN_HEAD (sequence ${orgPinned.sequence}). pnpm file verify --current checks the packet there too.`);
      }
    }
  } else if (orgPinned) {
    io.log("COUNTERAUDIT_MIN_HEAD not compared: this needs COUNTERAUDIT_ORG_ID and COUNTERAUDIT_READ_KEY to read the Bureau organization's head.");
  }
  return failed ? 1 : 0;
}

/**
 * Runs one pnpm review command. Returns the exit code: 0 done, 1 when submit
 * was refused or sync stopped at a problem, 2 when nothing ran.
 */
export async function runReview(
  argv: string[],
  io: ReviewIO = defaultIO
): Promise<number> {
  const [command, ...args] = argv.filter(arg => arg !== "--");
  const noArgs = (run: () => Promise<number>) =>
    args.length === 0 ? run() : (io.log(USAGE), Promise.resolve(2));
  switch (command) {
    case "keygen":
      return keygen(args, io);
    case "sign":
      return signCommand(args, io);
    case "key":
      return keyCommand(args, io);
    case "admit":
      return admitCommand(args, io);
    case "revoke-admission":
      return revokeAdmissionCommand(args, io);
    case "submit":
      return submit(args, io);
    case "approve-key":
      return approveKeyCommand(args, io);
    case "sync":
      return noArgs(() => sync(io));
    case "move":
      return noArgs(() => moveCommand(io));
    case "head":
      return noArgs(() => headCommand(io));
    case "queue":
      return noArgs(() => queue(io));
    case "admissions":
      return noArgs(() => admissionsCommand(io));
    case "settle":
      return noArgs(() => settleAll(io));
    case "apply":
      io.log(
        "pnpm review apply is retired: a decision counts only once its reviewer seals it in the review log with pnpm review submit, and the operator reads the log with pnpm review sync."
      );
      return 2;
    default:
      io.log(USAGE);
      return 2;
  }
}
