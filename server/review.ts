// pnpm review: two-person review of stored lines (docs/two-person-review.md).
// keygen, sign, key and submit run on a reviewer's own machine and need no
// database; the private key never leaves it, and submit seals the record in the
// independent review log with the reviewer's own ingest key. sync, queue and
// settle run where the intake runs, against the Bureau's database.
import { readFile, writeFile } from "node:fs/promises";
import { ENV } from "./_core/env";
import {
  findRelatingOutcomeLines,
  insertReviewLogRecords,
  listOutcomeLines,
  listReviewLogRecords,
  schemaReady,
} from "./db";
import { lineStates, releaseFor } from "./lineState";
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
  readReviewLog,
  submitReviewRecord,
  type Fetch,
} from "./reviewLogSync";
import { loadReviewLog, reviewsFor, settle } from "./settleLines";
import { REVIEW_DECISIONS } from "../drizzle/schema";

export const USAGE = [
  "Usage:",
  "  pnpm review keygen <private-key-file>",
  "  pnpm review sign --key <private-key-file> --reviewer <rev_id> --line <furnisher_id>/<event_id> --hash <signed_event_hash> --data-class <test|live> --evidence <evidence_digest> --decision <approve|approve_with_waiver|reject> [--reason <text>] --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --genesis <reviewers.json> --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --add <rev_id> --name <name> --public-key <ed25519:...> [--reason <text>] --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --rotate <rev_id> --public-key <ed25519:...> [--reason <text>] --out <record-file>",
  "  pnpm review key --key <private-key-file> --signer <rev_id> --<suspend|reenable|remove> <rev_id> [--reason <text>] --out <record-file>",
  "  pnpm review submit <record-file>",
  "  pnpm review sync",
  "  pnpm review queue",
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

// Writes a signed record to a new file for pnpm review submit, and shows it.
async function writeRecord(
  path: string,
  record: object,
  io: ReviewIO
): Promise<number> {
  try {
    await io.writeNewFile(path, `${JSON.stringify(record)}
`);
  } catch (error) {
    io.log(`Cannot write ${path}: ${describeError(error)}`);
    return 2;
  }
  io.log(
    `Signed and written to ${path}. Seal it with: pnpm review submit ${path}
${JSON.stringify(record)}`
  );
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
    (record.schema !== REVIEW_SCHEMA && record.schema !== REVIEWER_KEY_SCHEMA)
  ) {
    io.log(
      `${args[0]} holds neither a review decision nor a reviewer-key record. Nothing sealed.`
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
  return [read, `Reviewers: ${reviewers.join(", ") || "none"}.`];
}

const PAYMENT_OUTCOMES = new Set(["paid", "refunded", "payment_failed"]);

/**
 * What a line's evidence proved, by the names decided for review finding M-04
 * (docs/independent-payer.md): a verified payment proves a transfer settled, not
 * who controls the payer. The stored status stays `verified` until these become
 * the states in code, before any external file or API.
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

async function queue(io: ReviewIO) {
  if (!(await needDatabase(io))) return 2;
  const log = await loadReviewLog();
  for (const line of describeLog(log)) io.log(line);
  const lines = await listOutcomeLines();
  let waiting = 0;
  let released = 0;
  let closed = 0;
  for (const line of lines) {
    const relating = await findRelatingOutcomeLines(
      line.furnisherId,
      line.eventId
    );
    const reviews = reviewsFor(line, log);
    const states = lineStates(line, relating, reviews);
    if (states.withdrawn || states.superseded) {
      closed++;
      continue;
    }
    const release = releaseFor(line, reviews);
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
        `  proof ${line.proofOk ? "passed" : "not passed"}; evidence ${evidenceLabel(line.outcome, line.evidenceStatus)}${reasons ? `: ${reasons}` : ""}`,
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
    `${lines.length} line${lines.length === 1 ? "" : "s"}: ${waiting} waiting, ${released} released, ${closed} withdrawn or superseded.`
  );
  return 0;
}

// Re-settles every line against the review log.
async function settleEvery(io: ReviewIO, log: ReviewLog) {
  const lines = await listOutcomeLines();
  let changes = 0;
  for (const line of lines) {
    const changed = await settle(line, log);
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
    result = await readReviewLog({
      apiUrl: ENV.counterauditApiUrl,
      readKey: ENV.counterauditReviewReadKey,
      orgId: ENV.counterauditReviewOrgId,
      known: await listReviewLogRecords(),
      fetch: io.fetch,
      now: io.now(),
    });
  } catch (error) {
    io.log(`Could not read the review log: ${describeError(error)}.`);
    return 2;
  }
  const added = await insertReviewLogRecords(result.rows);
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
    case "submit":
      return submit(args, io);
    case "sync":
      return noArgs(() => sync(io));
    case "queue":
      return noArgs(() => queue(io));
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
