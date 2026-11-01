// End-to-end test of "a line expires with its CounterAudit source" (docs/agent-file.md, "When a
// line's source expires"), with real code on both sides. See docs/e2e-file-expiry.md.
//
//   COUNTERAUDIT_CHECKOUT=<path to a CounterAudit checkout> pnpm exec tsx scripts/e2e/file-expiry.ts
//
// It starts a throwaway Postgres and MySQL in Docker and a CounterAudit server from the checkout,
// runs each step, prints PASS or FAIL for each check, and removes what it started. Nothing here
// talks to a production service: the Bureau's CLIs run in this process with io objects that point
// at the local server and its export key.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import canonicalize from "canonicalize";
import type { FileIO } from "../../server/agentFile";
import type { Furnisher } from "../../server/furnishers";
import type { Jwk, Jwks } from "../../server/outcomeProof";
import type { ReviewIO } from "../../server/review";
import type { SigvaraClient } from "../../server/sigvaraStanding";

const PG_CONTAINER = "e2e-ca-pg";
const PG_PORT = 5442;
const MYSQL_CONTAINER = "e2e-bureau-mysql";
const MYSQL_PORT = 3317;
const CA_PORT = 3858;
const CA_URL = `http://127.0.0.1:${CA_PORT}`;
const CA_POSTGRES_URL = `postgresql://postgres:test@127.0.0.1:${PG_PORT}/ca`;
const EXPORT_KEY_ID = "e2e-local-export-1";
const FILE_KEY_ID = "e2e-file-1";
const FURNISH_CONNECTOR_ID = "agent-bureau-outcome-v1";
const OUTCOME_SIGNING_CONTEXT = "agent-bureau/outcome-event/v1\n";
// When CounterAudit allows an expires_at this close, steps 1 and 2 run before it.
const LEAD_MS = 3 * 60_000;
// The longest the test waits for expires_at to pass, rather than expiring against a chosen time.
const MAX_WAIT_MS = 15 * 60_000;

const BUREAU_ROOT = resolve(import.meta.dirname, "../..");
const CA_CHECKOUT = process.env.COUNTERAUDIT_CHECKOUT
  ? resolve(process.env.COUNTERAUDIT_CHECKOUT)
  : "";

// Every Bureau setting the code under test reads, set here so none comes from the shell. The
// review organization and its read key are set once CounterAudit has made them.
process.env.DATABASE_URL = `mysql://root:test@127.0.0.1:${MYSQL_PORT}/bureau`;
process.env.COUNTERAUDIT_API_URL = CA_URL;
// The Bureau's own organization takes no part: the line is sealed in the furnisher's.
process.env.COUNTERAUDIT_ORG_ID = randomUUID();
for (const name of [
  "COUNTERAUDIT_INGEST_KEY",
  "COUNTERAUDIT_REVIEW_ORG_ID",
  "COUNTERAUDIT_REVIEW_READ_KEY",
  "COUNTERAUDIT_REVIEW_INGEST_KEY",
]) {
  delete process.env[name];
}
// Nothing on Arc is read (no payment, no Sigvara subject); a dead address keeps it so.
process.env.ARC_TESTNET_RPC_URL = "http://127.0.0.1:9";
process.env.ARC_TESTNET_EXPLORER_URL = "http://127.0.0.1:9";

// ---- Reporting ----

class Stop extends Error {}
let checks = 0;

function expect(ok: boolean, what: string, detail?: string): void {
  if (ok) {
    checks++;
    console.log(`PASS ${what}`);
    return;
  }
  console.log(`FAIL ${what}${detail ? `: ${detail}` : ""}`);
  throw new Stop(what);
}
const note = (text: string) => console.log(`NOTE ${text}`);
const heading = (text: string) => console.log(`\n== ${text}`);

/** A Bureau CLI's log, printed indented as it runs and kept for the checks. */
function output() {
  const lines: string[] = [];
  return {
    lines,
    log(line: string) {
      for (const part of line.split("\n")) {
        lines.push(part);
        console.log(`    | ${part}`);
      }
    },
    has: (text: string) => lines.some(l => l.includes(text)),
  };
}

function duration(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 60) return `${Math.round(Math.abs(ms) / 1000)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// ---- Processes ----

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) {
  const out = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (out.error) throw out.error;
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function waitFor(
  what: string,
  ready: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 1000
) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await ready()) return;
    } catch (error) {
      if (error instanceof Stop) throw error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${what} was not ready within ${timeoutMs / 1000} s`);
}

/** The local CounterAudit server's settings: none of a real deployment's reach it. */
function counterauditEnv(
  exportKeyB64: string,
  sealKeyB64: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !/^(CA_|COUNTERAUDIT_|DATABASE_URL$|REDIS|PORT$|HOST$|NODE_ENV$)/i.test(
        name
      )
    ) {
      env[name] = value;
    }
  }
  return {
    ...env,
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(CA_PORT),
    CA_POSTGRES_URL,
    CA_EXPORT_SIGNING_PRIVATE_KEY_B64: exportKeyB64,
    CA_EXPORT_SIGNING_KEY_ID: EXPORT_KEY_ID,
    CA_SEAL_KEYS_JSON: JSON.stringify({ "e2e-seal-1": sealKeyB64 }),
    CA_SEAL_KEY_ID: "e2e-seal-1",
  };
}

// scripts/retention-expiry.js as it runs, with `now` set: runExpiry's option for expiring against
// a chosen time. Used only when expires_at is too far off to wait for.
const EXPIRE_AT = `
const { getPostgresPool } = require('./src/db/database');
const { warmSealKeyCache } = require('./src/services/sealKeyProvider');
const { runExpiry } = require('./src/services/erasureService');
(async () => {
  const [orgId, nowIso] = process.argv.slice(1);
  await warmSealKeyCache();
  const pool = await getPostgresPool();
  let report;
  try {
    report = await runExpiry({ orgId, now: new Date(nowIso) });
  } finally {
    await pool.end();
  }
  console.log(JSON.stringify({ success: true, ...report }, null, 2));
  process.exit(report.needs_attention ? 2 : 0);
})().catch((error) => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});`;

// ---- CounterAudit's API ----

type Answer = { status: number; body: any };

async function ca(
  method: string,
  path: string,
  key: string | null,
  body?: unknown
): Promise<Answer> {
  const res = await fetch(`${CA_URL}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

const brief = (answer: Answer) =>
  `${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`;

// ---- Keys and the events they sign ----

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    // As agent-bureau-furnish and pnpm review keygen print it.
    publicKey: `ed25519:${publicKey.export({ format: "jwk" }).x}`,
  };
}

/**
 * The earliest expires_at CounterAudit gives a packet sealed now under its shortest policy, at
 * least LEAD_MS ahead, and the received_at that gives it. CounterAudit counts expiry from
 * received_at only when that lies within maxAgeDays before the seal
 * (retentionService.retentionForPacket), and the date only rises with received_at.
 */
function earliestExpiry(
  now: number,
  months: number,
  maxAgeDays: number,
  addMonthsUtc: (date: Date, months: number) => Date
) {
  const expiry = (t: number) => addMonthsUtc(new Date(t), months).getTime();
  // A minute inside the window at each end, for the time the request takes to reach the seal.
  let lo = now - maxAgeDays * 86_400_000 + 60_000;
  let hi = now - 60_000;
  if (expiry(lo) < now + LEAD_MS) {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (expiry(mid) >= now + LEAD_MS) hi = mid;
      else lo = mid;
    }
    lo = hi;
  }
  return { receivedAt: new Date(lo), expiresAt: new Date(expiry(lo)) };
}

// The e2e reviewers and their genesis, made before any Bureau module loads: the loader hook puts
// this genesis in place of the pinned one as server/reviewLog.ts loads.
const reviewers = ["a", "b", "c"].map(letter => ({
  id: `rev_e2e${letter}`,
  name: `E2E reviewer ${letter.toUpperCase()}`,
  key: ed25519(),
}));
const genesisEntries = reviewers.map(r => ({
  reviewer_id: r.id,
  name: r.name,
  public_key: r.key.publicKey,
}));
const genesis = createHash("sha256")
  .update(
    canonicalize({ type: "genesis", reviewers: genesisEntries }) ?? "",
    "utf8"
  )
  .digest("hex");
register(new URL("./review-genesis-pin.mjs", import.meta.url), {
  data: { genesis },
});

// ---- The run ----

let server: ChildProcess | null = null;
let closeDb: (() => Promise<void>) | null = null;
let workDir = "";

async function main(): Promise<void> {
  heading("Setup");
  if (
    !CA_CHECKOUT ||
    !existsSync(join(CA_CHECKOUT, "scripts/retention-expiry.js"))
  ) {
    throw new Error(
      "Set COUNTERAUDIT_CHECKOUT to a CounterAudit checkout with its node_modules installed."
    );
  }
  // The server loads a .env from its working directory, and nothing of a real deployment's
  // settings may reach it.
  if (existsSync(join(CA_CHECKOUT, ".env"))) {
    throw new Error(
      `${CA_CHECKOUT} has a .env, which the CounterAudit server would load. Use a clean checkout or worktree.`
    );
  }
  const commit = (cwd: string) =>
    run("git", ["-C", cwd, "rev-parse", "--short", "HEAD"]).stdout.trim() ||
    "unknown";
  console.log(`Run at ${new Date().toISOString()}`);
  console.log(
    `Bureau ${commit(BUREAU_ROOT)}, CounterAudit ${commit(CA_CHECKOUT)} (COUNTERAUDIT_CHECKOUT)`
  );
  // Keys, records and files go in a directory of their own, named relative to it.
  workDir = await mkdtemp(join(tmpdir(), "bureau-e2e-"));
  process.chdir(workDir);

  const exportKey = ed25519();
  const caEnv = counterauditEnv(
    Buffer.from(exportKey.privateKeyPem).toString("base64"),
    randomBytes(32).toString("base64")
  );

  // Leftovers of an interrupted run go first.
  run("docker", ["rm", "-f", PG_CONTAINER, MYSQL_CONTAINER]);
  const pg = run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    PG_CONTAINER,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_PASSWORD=test",
    "-e",
    "POSTGRES_DB=ca",
    "-p",
    `127.0.0.1:${PG_PORT}:5432`,
    "postgres:16-alpine",
  ]);
  if (pg.status !== 0)
    throw new Error(`docker could not start Postgres: ${pg.stderr.trim()}`);
  const mysql = run("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    MYSQL_CONTAINER,
    "--tmpfs",
    "/var/lib/mysql",
    "-e",
    "MYSQL_ROOT_PASSWORD=test",
    "-e",
    "MYSQL_DATABASE=bureau",
    "-p",
    `127.0.0.1:${MYSQL_PORT}:3306`,
    "mysql:8",
  ]);
  if (mysql.status !== 0)
    throw new Error(`docker could not start MySQL: ${mysql.stderr.trim()}`);
  // Over TCP inside each container: during initialisation the servers listen on a socket only.
  await waitFor(
    "Postgres",
    () =>
      run("docker", [
        "exec",
        PG_CONTAINER,
        "psql",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "ca",
        "-c",
        "select 1",
      ]).status === 0,
    60_000
  );
  await waitFor(
    "MySQL",
    () =>
      run("docker", [
        "exec",
        MYSQL_CONTAINER,
        "mysql",
        "-h127.0.0.1",
        "-uroot",
        "-ptest",
        "-e",
        "select 1",
        "bureau",
      ]).status === 0,
    120_000
  );
  console.log(
    `Postgres (${PG_CONTAINER}, port ${PG_PORT}) and MySQL (${MYSQL_CONTAINER}, port ${MYSQL_PORT}) are up.`
  );

  const portTaken = await fetch(`${CA_URL}/`).then(
    () => true,
    () => false
  );
  if (portTaken)
    throw new Error(`something already answers on port ${CA_PORT}`);
  const logPath = "counteraudit.log";
  const logFd = openSync(logPath, "a");
  server = spawn(process.execPath, ["src/server.js"], {
    cwd: CA_CHECKOUT,
    env: caEnv,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  let jwks: Jwks = { keys: [] };
  await waitFor(
    "the CounterAudit server",
    async () => {
      if (server && server.exitCode !== null) {
        throw new Stop(`the CounterAudit server exited; its log is ${logPath}`);
      }
      const res = await fetch(
        `${CA_URL}/.well-known/counteraudit-export-jwk.json`
      );
      if (!res.ok) return false;
      jwks = (await res.json()) as Jwks;
      return true;
    },
    60_000
  );
  const localJwk = jwks.keys.find(k => k.kid === EXPORT_KEY_ID) as
    Jwk | undefined;
  if (!localJwk)
    throw new Error("the local server does not serve its export key");
  console.log(
    `CounterAudit is up at ${CA_URL}, signing with export key ${EXPORT_KEY_ID}.`
  );

  const limits = run(
    process.execPath,
    [
      "-e",
      "const r=require('./src/services/retentionService');process.stdout.write(JSON.stringify([r.MIN_RETENTION_MONTHS,r.RECEIVED_AT_MAX_AGE_DAYS]))",
    ],
    { cwd: CA_CHECKOUT, env: caEnv }
  );
  const [minMonths, maxAgeDays] = JSON.parse(limits.stdout) as [number, number];

  // The Bureau's modules, loaded now that the review genesis hook is in place.
  const db = await import("../../server/db");
  closeDb = db.closeDb;
  const { runFile } = await import("../../server/agentFile");
  const { runLines } = await import("../../server/lineExpiry");
  const { runIntake } = await import("../../server/furnishIntake");
  const { runReview } = await import("../../server/review");
  const { fetchProof } = await import("../../server/counteraudit");
  const { COUNTERAUDIT_EXPORT_KEYS } =
    await import("../../server/counterauditKeys");
  const { verifyLineTombstone } = await import("../../server/outcomeProof");
  const { evidenceDigest, reviewerPublicKey } =
    await import("../../server/reviewDecision");
  const { addMonthsUtc } = await import("../../server/retention");
  const { REVIEW_GENESIS, TESTNET_GENESIS } =
    await import("../../server/reviewLog");
  if (REVIEW_GENESIS !== genesis)
    throw new Error("the review genesis pin was not replaced");
  await db.runMigrations(join(BUREAU_ROOT, "drizzle"));
  if (!(await db.schemaReady()))
    throw new Error("the Bureau's migrations did not apply");
  console.log("The Bureau's migrations are applied.");
  note(
    `the review log counts only the genesis pinned in server/reviewLog.ts, whose reviewers' keys the operator holds. This run seals its own reviewers' genesis in a local review organization, and a loader hook (scripts/e2e/review-genesis-pin.mjs) puts its hash ${genesis.slice(0, 12)}... in place of the pin in this process (REVIEW_GENESIS, and TESTNET_GENESIS while it is the same: testnet ${REVIEW_GENESIS === TESTNET_GENESIS}). The decisions themselves are real: signed, sealed and read back.`
  );

  const tag = randomBytes(4).toString("hex");
  const line = (furnisherId: string, eventId: string) =>
    db
      .listFileLines()
      .then(rows =>
        rows.find(r => r.furnisherId === furnisherId && r.eventId === eventId)
      );

  // ---- 1 ----
  heading(
    "1. CounterAudit: a furnisher's organization with a retention policy seals a signed outcome event"
  );
  const furnisherId = `fur_e2e${tag}`;
  const keyId = "e2e-key-1";
  const furnisherKey = ed25519();
  const furnisherOrg = await ca("POST", "/v1/auth/signup", null, {
    email: `e2e-furnisher-${tag}@example.test`,
  });
  expect(
    furnisherOrg.status === 201,
    "1a the furnisher's organization is created (POST /v1/auth/signup)",
    brief(furnisherOrg)
  );
  const orgF: string = furnisherOrg.body.org_id;
  const adminF: string = furnisherOrg.body.api_key;
  const policy = await ca("PUT", "/v1/admin/retention", adminF, {
    retention_months: minMonths,
  });
  expect(
    policy.status === 200 &&
      policy.body?.policy?.retention_months === minMonths,
    `1b its retention policy is ${minMonths} month, the shortest CounterAudit allows (PUT /v1/admin/retention)`,
    brief(policy)
  );
  const signer = await ca("POST", "/v1/admin/outcome-signers", adminF, {
    furnisher_id: furnisherId,
    key_id: keyId,
    public_key: furnisherKey.publicKey,
    label: "e2e furnisher key",
  });
  expect(
    signer.status === 201,
    `1c the furnisher's signing key ${furnisherId}/${keyId} is registered there (POST /v1/admin/outcome-signers)`,
    brief(signer)
  );
  const ingestKey = await ca("POST", "/v1/admin/keys", adminF, {
    label: "e2e furnisher ingest",
    role: "ingest",
    expires_in_days: 1,
  });
  expect(
    ingestKey.status === 201 && typeof ingestKey.body?.api_key === "string",
    "1d the furnisher has an ingest key (POST /v1/admin/keys, role ingest)",
    brief(ingestKey)
  );

  const now = Date.now();
  const { receivedAt, expiresAt } = earliestExpiry(
    now,
    minMonths,
    maxAgeDays,
    addMonthsUtc
  );
  const lead = expiresAt.getTime() - now;
  note(
    `CounterAudit's shortest policy is ${minMonths} month, counted from received_at when that is at most ${maxAgeDays} days before the seal. For a packet sealed at ${new Date(now).toISOString()} the earliest expires_at is ${expiresAt.toISOString()} (received_at ${receivedAt.toISOString()}), ${duration(lead)} ahead.`
  );
  const unsigned = {
    schema_version: "1",
    furnisher_id: furnisherId,
    key_id: keyId,
    event_id: `e2e-${now}`,
    subject_ref: { did: `did:example:e2e-${tag}` },
    occurred_at: new Date(receivedAt.getTime() - 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    outcome: "delivered",
  };
  const signature = sign(
    null,
    Buffer.from(OUTCOME_SIGNING_CONTEXT + canonicalize(unsigned), "utf8"),
    furnisherKey.privateKey
  ).toString("base64url");
  const event = { ...unsigned, signature: `ed25519:${signature}` };
  const sealed = await ca("POST", "/v1/audit/ingest", ingestKey.body.api_key, {
    connector_id: FURNISH_CONNECTOR_ID,
    raw_event: event,
    public_proof: true,
    received_at: receivedAt.toISOString(),
  });
  expect(
    sealed.status === 201 && typeof sealed.body?.packet_id === "string",
    `1e the signed event is sealed with a public proof and received_at (POST /v1/audit/ingest): packet ${sealed.body?.packet_id}`,
    brief(sealed)
  );
  const packetId: string = sealed.body.packet_id;
  const proof = await ca("GET", `/v1/proofs/${packetId}`, null);
  const provedExpiry: string | undefined = proof.body?.expires_at;
  expect(
    proof.status === 200 && provedExpiry === expiresAt.toISOString(),
    `1f its public proof says expires_at ${provedExpiry}, ${duration(Date.parse(String(provedExpiry)) - Date.parse(proof.body?.created_at))} after the seal at ${proof.body?.created_at}`,
    `expected ${expiresAt.toISOString()}; ${brief(proof)}`
  );
  const honest = expiresAt.getTime() - Date.now() <= MAX_WAIT_MS;

  // ---- 2 ----
  heading(
    "2. The Bureau stores the line, reviewers release it, and pnpm file assemble signs a file verify accepts"
  );
  const furnishers: Record<string, Furnisher> = {
    [furnisherId]: {
      counterauditOrgId: orgF,
      keys: {
        [keyId]: { publicKey: furnisherKey.publicKey, status: "active" },
      },
    },
  };
  note(
    `the furnisher is listed for this run in the io's furnishers (organization ${orgF}), not in server/furnishers.ts.`
  );
  const sealedPath = "sealed.jsonl";
  await writeFile(
    sealedPath,
    `${JSON.stringify({ packet_id: packetId, event })}\n`
  );
  note(
    "the intake checks proofs against the export keys pinned in server/counterauditKeys.ts and takes none from its caller, so the local server's export key is added to that list in memory for the intake's run only, and taken out after it."
  );
  const intake = output();
  COUNTERAUDIT_EXPORT_KEYS.keys.push(localJwk);
  let intakeCode: number;
  try {
    intakeCode = await runIntake(
      ["--test-data", "--sealed", sealedPath],
      {
        readText: path => readFile(path, "utf8"),
        log: intake.log,
        now: () => new Date(),
      },
      furnishers
    );
  } finally {
    COUNTERAUDIT_EXPORT_KEYS.keys.splice(
      COUNTERAUDIT_EXPORT_KEYS.keys.indexOf(localJwk),
      1
    );
  }
  const stored = await line(furnisherId, event.event_id);
  expect(
    intakeCode === 0 &&
      intake.has("proof verified") &&
      stored?.proofOk === true,
    "2a pnpm furnish:intake --test-data --sealed stores the line, its proof verified",
    `exit ${intakeCode}`
  );
  if (!stored) throw new Stop("no stored line");

  // The review organization: the reviewers' ingest keys and the Bureau's read key.
  const reviewOrg = await ca("POST", "/v1/auth/signup", null, {
    email: `e2e-review-${tag}@example.test`,
  });
  const adminR: string = reviewOrg.body?.api_key;
  const readKey = await ca("POST", "/v1/admin/keys", adminR, {
    label: "e2e bureau read",
    role: "read",
    expires_in_days: 1,
  });
  const reviewerKeys: string[] = [];
  for (const r of reviewers) {
    const created = await ca("POST", "/v1/admin/keys", adminR, {
      label: `e2e ${r.id}`,
      role: "ingest",
      expires_in_days: 1,
    });
    reviewerKeys.push(created.body?.api_key);
  }
  expect(
    reviewOrg.status === 201 &&
      readKey.status === 201 &&
      reviewerKeys.every(k => typeof k === "string"),
    "2b a review organization with an ingest key for each reviewer and a read key for the Bureau",
    brief(readKey)
  );
  process.env.COUNTERAUDIT_REVIEW_ORG_ID = reviewOrg.body.org_id;
  process.env.COUNTERAUDIT_REVIEW_READ_KEY = readKey.body.api_key;

  const review = output();
  const reviewIO: ReviewIO = {
    readText: path => readFile(path, "utf8"),
    writeNewPrivateFile: (path, text) =>
      writeFile(path, text, { flag: "wx", mode: 0o600 }),
    writeNewFile: (path, text) => writeFile(path, text, { flag: "wx" }),
    log: review.log,
    now: () => new Date(),
    fetch: (url, init) => fetch(url, init),
  };
  const reviewersPath = "reviewers.json";
  await writeFile(reviewersPath, JSON.stringify(genesisEntries));
  let reviewCodes: number[] = [];
  const submitAs = async (index: number, record: string) => {
    process.env.COUNTERAUDIT_REVIEW_INGEST_KEY = reviewerKeys[index];
    try {
      return await runReview(["submit", record], reviewIO);
    } finally {
      delete process.env.COUNTERAUDIT_REVIEW_INGEST_KEY;
    }
  };
  for (const [index, r] of reviewers.entries()) {
    const keyPath = `${r.id}.key`;
    await writeFile(keyPath, r.key.privateKeyPem, { mode: 0o600 });
    const record = `genesis-${r.id}.json`;
    reviewCodes.push(
      await runReview(
        [
          "key",
          "--key",
          keyPath,
          "--signer",
          r.id,
          "--genesis",
          reviewersPath,
          "--out",
          record,
        ],
        reviewIO
      ),
      await submitAs(index, record)
    );
  }
  expect(
    reviewCodes.every(c => c === 0) && review.has(`Genesis hash: ${genesis}`),
    "2c the three reviewers sign and seal their genesis (pnpm review key --genesis, pnpm review submit)",
    `exits ${reviewCodes.join(", ")}`
  );
  reviewCodes = [];
  for (const [index, r] of reviewers.slice(0, 2).entries()) {
    const record = `decision-${r.id}.json`;
    reviewCodes.push(
      await runReview(
        [
          "sign",
          "--key",
          `${r.id}.key`,
          "--reviewer",
          r.id,
          "--line",
          `${furnisherId}/${event.event_id}`,
          "--hash",
          stored.signedEventHash,
          "--data-class",
          "test",
          "--evidence",
          evidenceDigest(stored.evidenceResult),
          "--decision",
          "approve_with_waiver",
          "--reason",
          "e2e test: no machine check exists for delivered outcomes",
          "--out",
          record,
        ],
        reviewIO
      ),
      await submitAs(index, record)
    );
  }
  const syncCode = await runReview(["sync"], reviewIO);
  const released = await line(furnisherId, event.event_id);
  expect(
    reviewCodes.every(c => c === 0) &&
      syncCode === 0 &&
      released?.displayState === "released",
    "2d two reviewers approve the line (pnpm review sign, pnpm review submit), and pnpm review sync shows it released",
    `exits ${[...reviewCodes, syncCode].join(", ")}, display state ${released?.displayState}`
  );

  const files = output();
  const noChain = new Proxy({} as SigvaraClient, {
    get: () => async () => {
      throw new Error(
        "the e2e subject is not a Sigvara agent, so the chain is not read"
      );
    },
  });
  const fileKeyPath = "bureau-file.key";
  const fileKeys: Record<string, string> = {};
  const fileIO = (overrides: Partial<FileIO> = {}): FileIO => ({
    readText: path => readFile(path, "utf8"),
    writeNewPrivateFile: (path, text) =>
      writeFile(path, text, { flag: "wx", mode: 0o600 }),
    writeNewFile: (path, text) => writeFile(path, text, { flag: "wx" }),
    log: files.log,
    now: () => new Date(),
    fetchProof,
    fetch: (url, init) => fetch(url, init),
    jwks,
    keys: fileKeys,
    furnishers,
    sigvara: noChain,
    ...overrides,
  });
  const keygenCode = await runFile(["keygen", fileKeyPath], fileIO());
  if (keygenCode !== 0) throw new Stop("pnpm file keygen failed");
  fileKeys[FILE_KEY_ID] = reviewerPublicKey(
    await readFile(fileKeyPath, "utf8")
  );
  note(
    `the io for pnpm file and pnpm lines carries the local server's export key (${EXPORT_KEY_ID}) in place of server/counterauditKeys.ts, and this run's file key pinned as ${FILE_KEY_ID} in place of server/bureauFileKeys.ts.`
  );
  const subject = JSON.stringify(unsigned.subject_ref);
  const assemble = (out: string) =>
    runFile(
      [
        "assemble",
        "--subject",
        subject,
        "--key",
        fileKeyPath,
        "--key-id",
        FILE_KEY_ID,
        "--out",
        out,
      ],
      fileIO()
    );
  const filePath = "file.json";
  const assembled = await assemble(filePath);
  const file =
    assembled === 0 ? JSON.parse(await readFile(filePath, "utf8")) : null;
  const fileLine = file?.furnished_outcomes?.[0];
  expect(
    assembled === 0 &&
      file.furnished_outcomes.length === 1 &&
      fileLine.counteraudit.packet_id === packetId &&
      fileLine.counteraudit.org_id === orgF &&
      fileLine.released === "two_person" &&
      fileLine.counteraudit.checkable_until === provedExpiry &&
      file.disclosures.some((d: string) =>
        d.includes("counteraudit.checkable_until")
      ),
    `2e pnpm file assemble signs a file whose line has checkable_until ${fileLine?.counteraudit?.checkable_until}, the proof's expires_at, with the disclosure for it`,
    `exit ${assembled}, line ${JSON.stringify(fileLine?.counteraudit)}`
  );
  files.lines.length = 0;
  const verified = await runFile(["verify", filePath], fileIO());
  expect(
    verified === 0 && files.has(`${packetId}: proof verified`),
    "2f pnpm file verify: exit 0, proof verified",
    `exit ${verified}`
  );

  // ---- 3 ----
  heading(
    "3. CounterAudit's retention job erases the packet; its proof URL answers 410 with a signed tombstone"
  );
  const retention = (args: string[]) => {
    const out = run(process.execPath, args, { cwd: CA_CHECKOUT, env: caEnv });
    let report: any = null;
    try {
      report = JSON.parse(out.stdout);
    } catch {
      report = null;
    }
    // The job prints a JSON report; its totals are enough here, and the rest when it fails.
    const text = report
      ? `exit ${out.status}: erased ${report.erased}, refused ${report.refused}, needs_attention ${report.needs_attention}, ran_at ${report.ran_at}`
      : `exit ${out.status}: ${out.stdout}${out.stderr}`;
    for (const part of text.trim().split("\n")) console.log(`    | ${part}`);
    return { status: out.status, report };
  };
  const early = retention(["scripts/retention-expiry.js", "--org", orgF]);
  expect(
    early.status === 0 && early.report?.erased === 0,
    "3a node scripts/retention-expiry.js --org <furnisher org>, run before expires_at, erases nothing",
    `exit ${early.status}`
  );
  let job: ReturnType<typeof retention>;
  if (honest) {
    while (Date.now() < expiresAt.getTime() + 1000) {
      console.log(`Waiting for expires_at ${expiresAt.toISOString()}...`);
      await sleep(Math.min(30_000, expiresAt.getTime() + 1000 - Date.now()));
    }
    job = retention(["scripts/retention-expiry.js", "--org", orgF]);
    expect(
      job.status === 0 && job.report?.erased === 1,
      "3b once expires_at has passed, node scripts/retention-expiry.js --org <furnisher org> erases the packet",
      `exit ${job.status}`
    );
  } else {
    const at = new Date(expiresAt.getTime() + 1000).toISOString();
    note(
      `APPROXIMATION: expires_at is ${duration(expiresAt.getTime() - Date.now())} away, too long to wait, and CounterAudit gives no earlier date honestly: its shortest policy is ${minMonths} month and received_at may be at most ${maxAgeDays} days before the seal, so on this date a packet expires ${duration(lead)} after its seal at the earliest. Instead of waiting, the test runs what scripts/retention-expiry.js runs, runExpiry from src/services/erasureService.js, with its now option set to ${at}, 1 s past expires_at. No CounterAudit code or database row is changed.`
    );
    job = retention(["-e", EXPIRE_AT, orgF, at]);
    expect(
      job.status === 0 && job.report?.erased === 1,
      `3b runExpiry({ orgId, now: ${at} }), as the script runs it, erases the packet`,
      `exit ${job.status}`
    );
  }
  // The server caches a proof for 60 s, and the job ran in a process of its own.
  const erasedAt = Date.now();
  let gone: Answer = { status: 0, body: null };
  await waitFor(
    "the 410",
    async () => {
      gone = await ca("GET", `/v1/proofs/${packetId}`, null);
      return gone.status === 410;
    },
    90_000,
    3000
  ).catch(() => undefined);
  const tombstone = gone.body;
  const tombstoneCheck = verifyLineTombstone({
    tombstone,
    jwks,
    packetId,
    orgId: orgF,
    sequence: fileLine.counteraudit.sequence,
    entryHash: fileLine.counteraudit.entry_hash,
  });
  expect(
    gone.status === 410 && tombstone?.signature != null && tombstoneCheck.ok,
    `3c GET /v1/proofs/${packetId} answers 410 with a tombstone the export key signed, erased at ${tombstone?.expired_at} (the server answered 200 from its proof cache for ${duration(Date.now() - erasedAt)} after the erasure)`,
    brief(gone)
  );

  // ---- 4 ----
  heading(
    "4. pnpm file verify reports the line expired; a tampered tombstone fails"
  );
  files.lines.length = 0;
  const expiredVerify = await runFile(["verify", filePath], fileIO());
  expect(
    expiredVerify === 0 &&
      files.has(`${packetId}: expired: CounterAudit erased its source`),
    "4a pnpm file verify on the same file: the line is expired, CounterAudit erased its source, exit 0",
    `exit ${expiredVerify}`
  );
  files.lines.length = 0;
  const tampered = await runFile(
    ["verify", filePath],
    fileIO({
      // A copy of CounterAudit's answer with the time of erasure moved by a second.
      fetchProof: async id => {
        const got = await fetchProof(id);
        if (got.ok || !got.tombstone) return got;
        const when = new Date(
          Date.parse(String(got.tombstone.expired_at)) + 1000
        ).toISOString();
        return { ...got, tombstone: { ...got.tombstone, expired_at: when } };
      },
    })
  );
  expect(
    tampered === 1 && files.has(`${packetId}: erasure record FAILED`),
    "4b the same verify, served a tombstone whose expired_at was moved by a second: erasure record FAILED, exit 1",
    `exit ${tampered}`
  );
  files.lines.length = 0;
  const beforeErasePath = "file-before-lines-expire.json";
  const leftOff = await assemble(beforeErasePath);
  const beforeErase =
    leftOff === 0 ? JSON.parse(await readFile(beforeErasePath, "utf8")) : null;
  expect(
    leftOff === 0 &&
      beforeErase.furnished_outcomes.length === 0 &&
      files.has(`Left off, its source has expired: ${packetId}`),
    "4c pnpm file assemble, before the Bureau erases its copy, leaves the line off and names it",
    `exit ${leftOff}`
  );

  // ---- 5 ----
  heading(
    "5. pnpm lines expire erases the Bureau's copy; a fresh file leaves the line off"
  );
  const lines = output();
  const linesIO = {
    log: lines.log,
    now: () => new Date(),
    fetchProof,
    jwks,
    furnishers,
  };
  const dry = await runLines(["expire", "--dry-run"], linesIO);
  const afterDry = await line(furnisherId, event.event_id);
  expect(
    dry === 0 &&
      lines.has("would be erased") &&
      afterDry?.expiredAt === null &&
      afterDry?.subjectRef !== null,
    "5a pnpm lines expire --dry-run names the line and changes nothing",
    `exit ${dry}`
  );
  const expired = await runLines(["expire"], linesIO);
  const erased = await line(furnisherId, event.event_id);
  expect(
    expired === 0 &&
      erased?.subjectRef === null &&
      erased?.signedEvent === null &&
      erased?.expiredAt instanceof Date,
    `5b pnpm lines expire erases it: subjectRef and signedEvent null, expiredAt ${erased?.expiredAt instanceof Date ? erased.expiredAt.toISOString() : erased?.expiredAt}`,
    `exit ${expired}, row ${JSON.stringify({ subjectRef: erased?.subjectRef, signedEvent: erased?.signedEvent === null ? null : "kept", expiredAt: erased?.expiredAt })}`
  );
  files.lines.length = 0;
  const freshPath = "file-after-lines-expire.json";
  const fresh = await assemble(freshPath);
  const freshFile =
    fresh === 0 ? JSON.parse(await readFile(freshPath, "utf8")) : null;
  expect(
    fresh === 0 &&
      freshFile.furnished_outcomes.length === 0 &&
      freshFile.history.length === 0,
    "5c a fresh pnpm file assemble for the same subject signs a file without the line, exit 0",
    `exit ${fresh}`
  );
}

async function teardown(keepWorkDir: boolean) {
  heading("Teardown");
  try {
    await closeDb?.();
  } catch {
    // The pool may never have opened.
  }
  if (server && server.exitCode === null) {
    const exited = new Promise(done => server?.once("exit", done));
    server.kill();
    // It holds its log open in the work directory until it has gone.
    await Promise.race([exited, sleep(10_000)]);
    console.log("Stopped the CounterAudit server.");
  }
  const removed = run("docker", ["rm", "-f", PG_CONTAINER, MYSQL_CONTAINER]);
  console.log(
    removed.status === 0
      ? `Removed the containers ${PG_CONTAINER} and ${MYSQL_CONTAINER}, if they were there.`
      : `docker rm -f: ${removed.stderr.trim()}`
  );
  process.chdir(BUREAU_ROOT);
  if (workDir && !keepWorkDir) {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5 }).catch(
      error =>
        console.log(
          `Could not remove ${workDir}: ${error instanceof Error ? error.message : error}`
        )
    );
  }
  if (workDir && keepWorkDir) {
    console.log(
      `Kept ${workDir}: keys, files and the server's log (counteraudit.log).`
    );
  }
}

let failed = true;
process.on("SIGINT", () => {
  void teardown(true).finally(() => process.exit(130));
});
try {
  await main();
  failed = false;
} catch (error) {
  if (!(error instanceof Stop)) {
    console.log(
      `FAIL ${error instanceof Error ? error.message : String(error)}`
    );
  }
} finally {
  await teardown(failed);
}
console.log(
  failed ? "\nThe e2e test FAILED." : `\nAll ${checks} checks passed.`
);
process.exitCode = failed ? 1 : 0;
