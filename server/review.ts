// pnpm review: two-person review of stored lines (docs/two-person-review.md).
// keygen and sign run on a reviewer's own machine and need no database; the
// private key never leaves it. queue, apply and settle run where the intake
// runs, against the Bureau's database.
import { readFile, writeFile } from "node:fs/promises";
import { ENV } from "./_core/env";
import {
  findRelatingOutcomeLines,
  getOutcomeLine,
  insertOutcomeReview,
  listOutcomeLines,
  schemaReady,
} from "./db";
import { lineStates, releaseFor } from "./lineState";
import { isRecord } from "./outcomeProof";
import {
  REVIEWERS,
  REVIEW_SCHEMA,
  assertDistinctReviewers,
  checkReviewDecision,
  decisionHash,
  evidenceDigest,
  newReviewerKey,
  reviewerPublicKey,
  signReviewDecision,
  type Reviewer,
  type ReviewDecisionKind,
} from "./reviewDecision";
import { reviewsFor, settle } from "./settleLines";
import { REVIEW_DECISIONS } from "../drizzle/schema";

export const USAGE = [
  "Usage:",
  "  pnpm review keygen <private-key-file>",
  "  pnpm review sign --key <private-key-file> --reviewer <rev_id> --line <furnisher_id>/<event_id> --hash <signed_event_hash> --data-class <test|live> --evidence <evidence_digest> --decision <approve|approve_with_waiver|reject> [--reason <text>]",
  "  pnpm review queue",
  "  pnpm review apply <decisions.jsonl>",
  "  pnpm review settle",
].join("\n");

export type ReviewIO = {
  readText(path: string): Promise<string>;
  // Writes a new file readable only by its owner; fails if it exists.
  writeNewPrivateFile(path: string, text: string): Promise<void>;
  log(line: string): void;
  now(): Date;
};

const defaultIO: ReviewIO = {
  readText: path => readFile(path, "utf8"),
  writeNewPrivateFile: (path, text) =>
    writeFile(path, text, { flag: "wx", mode: 0o600 }),
  log: line => console.log(line),
  now: () => new Date(),
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
    if (!name?.startsWith("--") || value === undefined) return null;
    flags[name.slice(2)] = value;
  }
  return flags;
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
      "To be listed, open a pull request adding to REVIEWERS in server/reviewDecision.ts:",
      `  rev_yourname: { name: "Your Name", publicKey: "${publicKey}" },`,
    ].join("\n")
  );
  return 0;
}

async function signCommand(
  args: string[],
  io: ReviewIO,
  reviewers: Record<string, Reviewer>
): Promise<number> {
  const flags = readFlags(args);
  const required = [
    "key",
    "reviewer",
    "line",
    "hash",
    "data-class",
    "evidence",
    "decision",
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
  let privateKeyPem: string;
  let publicKey: string;
  try {
    privateKeyPem = await io.readText(flags.key);
    publicKey = reviewerPublicKey(privateKeyPem);
  } catch (error) {
    io.log(
      `Cannot read the private key in ${flags.key}: ${describeError(error)}`
    );
    return 2;
  }
  const listed = Object.hasOwn(reviewers, flags.reviewer)
    ? reviewers[flags.reviewer]
    : undefined;
  if (listed && listed.publicKey !== publicKey) {
    io.log(`This key is not ${flags.reviewer}'s listed key. Nothing signed.`);
    return 2;
  }
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
    privateKeyPem
  );
  // The same checks the Bureau runs, against this key, before anything is
  // handed over.
  const check = checkReviewDecision(
    decision,
    { [flags.reviewer]: { name: "", publicKey } },
    io.now()
  );
  if (!check.ok) {
    io.log(`Not signed: ${check.reason}.`);
    return 2;
  }
  io.log(JSON.stringify(decision));
  if (!listed) {
    io.log(
      `Note: ${flags.reviewer} is not listed in REVIEWERS yet, so the Bureau will refuse this decision until it is.`
    );
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

async function queue(io: ReviewIO, reviewers: Record<string, Reviewer>) {
  if (!(await needDatabase(io))) return 2;
  const lines = await listOutcomeLines();
  let waiting = 0;
  let released = 0;
  let closed = 0;
  for (const line of lines) {
    const relating = await findRelatingOutcomeLines(
      line.furnisherId,
      line.eventId
    );
    const reviews = await reviewsFor(line, reviewers);
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
    io.log(
      [
        `${line.furnisherId}/${line.eventId}  ${line.outcome}  ${line.dataClass} data  shown ${line.displayState}`,
        `  hash ${line.signedEventHash}`,
        `  proof ${line.proofOk ? "passed" : "not passed"}; evidence ${evidenceLabel(line.outcome, line.evidenceStatus)}${reasons ? `: ${reasons}` : ""}`,
        // Subject control is Phase 3 and the funding screen is not built, so a
        // payment line has neither yet (docs/independent-payer.md, layers 2 and 3).
        ...(PAYMENT_OUTCOMES.has(line.outcome)
          ? [
              "  subject_control unproven; payer_independence_screen inconclusive (not built yet)",
              "  check: a settled payment proves that money moved between two wallets, not who controls them or whether the service was delivered; reject if you judge the payer related to the furnisher",
            ]
          : []),
        release.released
          ? `  released (${release.released === "solo_test" ? "one reviewer, test data" : "two reviewers"})`
          : `  review: ${release.holdingBack}`,
        `  sign with: --line ${line.furnisherId}/${line.eventId} --hash ${line.signedEventHash} --data-class ${line.dataClass} --evidence ${evidenceDigest(line.evidenceResult)}`,
      ].join("\n")
    );
  }
  io.log(
    `${lines.length} line${lines.length === 1 ? "" : "s"}: ${waiting} waiting, ${released} released, ${closed} withdrawn or superseded. Listed reviewers: ${Object.keys(reviewers).length}.`
  );
  return 0;
}

async function applyLine(
  text: string,
  io: ReviewIO,
  reviewers: Record<string, Reviewer>
): Promise<{ report: string; ok: boolean }> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { report: "refused: not valid JSON", ok: false };
  }
  const now = io.now();
  const checked = checkReviewDecision(value, reviewers, now);
  if (!checked.ok) return { report: `refused: ${checked.reason}`, ok: false };
  const decision = checked.decision;
  const label = `${decision.reviewer_id} ${decision.decision} ${decision.furnisher_id}/${decision.event_id}`;
  const line = await getOutcomeLine(decision.furnisher_id, decision.event_id);
  if (!line) {
    return {
      report: `${label}: refused, the Bureau holds no such line`,
      ok: false,
    };
  }
  if (line.signedEventHash !== decision.signed_event_hash) {
    return {
      report: `${label}: refused, signed_event_hash is not the stored event's`,
      ok: false,
    };
  }
  if (line.dataClass !== decision.data_class) {
    return {
      report: `${label}: refused, it was signed for ${decision.data_class} data and the line is ${line.dataClass}`,
      ok: false,
    };
  }
  // A rejection holds the line whatever it was signed against; an approval
  // for evidence that has since changed would not count, so it is refused.
  if (
    decision.decision !== "reject" &&
    decision.evidence_digest !== evidenceDigest(line.evidenceResult)
  ) {
    return {
      report: `${label}: refused, the line's evidence changed since it was signed; review it again from pnpm review queue`,
      ok: false,
    };
  }
  const recorded = await insertOutcomeReview({
    outcomeEventId: line.id,
    reviewerId: decision.reviewer_id,
    decision: decision.decision,
    reason: decision.reason ?? null,
    signedEventHash: decision.signed_event_hash,
    decidedAt: new Date(decision.decided_at),
    recordedAt: now,
    decisionHash: decisionHash(decision),
    signedDecision: decision,
  });
  const changed = await settle(line, reviewers);
  const release = releaseFor(line, await reviewsFor(line, reviewers));
  const shown = changed ?? line.displayState;
  const status = release.released
    ? `released${release.released === "solo_test" ? " by one reviewer (test data)" : ""}`
    : `not released: ${release.holdingBack}`;
  return {
    report: `${label}: ${recorded ? "recorded" : "already recorded"}; ${status}; shown ${shown}`,
    ok: true,
  };
}

async function apply(
  args: string[],
  io: ReviewIO,
  reviewers: Record<string, Reviewer>
): Promise<number> {
  if (args.length !== 1) {
    io.log(USAGE);
    return 2;
  }
  if (!(await needDatabase(io))) return 2;
  let text: string;
  try {
    text = await io.readText(args[0]);
  } catch (error) {
    io.log(`Cannot read ${args[0]}: ${describeError(error)}`);
    return 2;
  }
  let allOk = true;
  let count = 0;
  const fileLines = text.split(/\r?\n/);
  for (let index = 0; index < fileLines.length; index++) {
    const line = fileLines[index].trim();
    if (line === "") continue;
    count++;
    let result: { report: string; ok: boolean };
    try {
      result = await applyLine(line, io, reviewers);
    } catch (error) {
      result = {
        report: `not recorded (${describeError(error)}); run again`,
        ok: false,
      };
    }
    if (!result.ok) allOk = false;
    io.log(`line ${index + 1}: ${result.report}`);
  }
  if (count === 0) {
    io.log("No decisions in the file.");
    return 1;
  }
  return allOk ? 0 : 1;
}

// Re-settles every line, for after REVIEWERS changes.
async function settleAll(io: ReviewIO, reviewers: Record<string, Reviewer>) {
  if (!(await needDatabase(io))) return 2;
  const lines = await listOutcomeLines();
  let changes = 0;
  for (const line of lines) {
    const changed = await settle(line, reviewers);
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
  return 0;
}

/**
 * Runs one pnpm review command. Returns the exit code: 0 done, 1 when any
 * decision in an apply was refused or not recorded, 2 when nothing ran.
 */
export async function runReview(
  argv: string[],
  io: ReviewIO = defaultIO,
  reviewers: Record<string, Reviewer> = REVIEWERS
): Promise<number> {
  const [command, ...args] = argv.filter(arg => arg !== "--");
  try {
    assertDistinctReviewers(reviewers);
  } catch (error) {
    io.log(`The reviewer list is unusable: ${describeError(error)}`);
    return 2;
  }
  switch (command) {
    case "keygen":
      return keygen(args, io);
    case "sign":
      return signCommand(args, io, reviewers);
    case "queue":
      return args.length === 0 ? queue(io, reviewers) : (io.log(USAGE), 2);
    case "apply":
      return apply(args, io, reviewers);
    case "settle":
      return args.length === 0 ? settleAll(io, reviewers) : (io.log(USAGE), 2);
    default:
      io.log(USAGE);
      return 2;
  }
}
