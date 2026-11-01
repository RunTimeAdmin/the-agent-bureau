import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createPool, type Pool } from "mysql2";
import {
  DisputeRecordRow,
  InsertDisputeRecord,
  InsertInquiry,
  InsertOutcomeEvent,
  InsertReviewLogRecord,
  ReviewLogRecordRow,
  ReviewLogSyncRow,
  agents,
  dailyUsage,
  disputeRecords,
  inquiries,
  outcomeEvents,
  playQuestions,
  plays,
  reviewLogRecords,
  reviewLogSync,
} from "../drizzle/schema";
import type { DisplayState, Line } from "./lineState";

let _db: ReturnType<typeof drizzle> | null = null;
let _pool: Pool | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = createPool(process.env.DATABASE_URL);
      _pool = pool;
      // Pin every pooled connection to UTC. Daily windows and registration
      // counts compare a UTC value with DEFAULT(now()) TIMESTAMP columns, which
      // MySQL reads in the session time zone; without this the day could start
      // hours off on a host whose zone is not UTC.
      pool.on("connection", connection => {
        connection.query("SET time_zone = '+00:00'");
      });
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// Ends the pool so a one-off script (scripts/furnish-intake.ts) can exit. The
// server never calls this.
export async function closeDb(): Promise<void> {
  const pool = _pool;
  _pool = null;
  _db = null;
  if (!pool) return;
  await new Promise<void>((resolve, reject) =>
    pool.end(error => (error ? reject(error) : resolve()))
  );
}

// Applies pending drizzle/ migrations so hosts without shell access still get
// the schema. Applied migrations are recorded and skipped on later runs.
export async function runMigrations(migrationsFolder: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  await migrate(db, { migrationsFolder });
  return true;
}

export async function createInquiry(inquiry: InsertInquiry): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database is not available");
  }
  await db.insert(inquiries).values(inquiry);
}

export async function listInquiries() {
  const db = await getDb();
  if (!db) {
    throw new Error("Database is not available");
  }
  return db
    .select()
    .from(inquiries)
    .orderBy(desc(inquiries.createdAt), desc(inquiries.id));
}

export async function updateInquiryStatus(
  id: number,
  status: "new" | "reviewed" | "closed"
): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database is not available");
  }
  await db.update(inquiries).set({ status }).where(eq(inquiries.id, id));
}

// Permanent: used for deletion requests and test entries.
export async function deleteInquiry(id: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database is not available");
  }
  await db.delete(inquiries).where(eq(inquiries.id, id));
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new Error("Database is not available");
  }
  return db;
}

export async function createPlay(
  id: string,
  caseId: string,
  agentId: number | null = null
): Promise<void> {
  const db = await requireDb();
  await db.insert(plays).values({ id, caseId, agentId });
}

export async function getPlay(id: string) {
  const db = await requireDb();
  const [play] = await db.select().from(plays).where(eq(plays.id, id));
  return play;
}

export async function listPlayQuestions(playId: string) {
  const db = await requireDb();
  return db
    .select()
    .from(playQuestions)
    .where(eq(playQuestions.playId, playId))
    .orderBy(asc(playQuestions.id));
}

// Reserves one question in a single UPDATE, so parallel requests cannot push
// a game past its limit. Returns false when none are left or the game is over.
export async function claimQuestion(
  playId: string,
  limit: number
): Promise<boolean> {
  const db = await requireDb();
  const [result] = await db
    .update(plays)
    .set({ questionsUsed: sql`${plays.questionsUsed} + 1` })
    .where(
      and(
        eq(plays.id, playId),
        lt(plays.questionsUsed, limit),
        isNull(plays.finishedAt)
      )
    );
  return result.affectedRows === 1;
}

export async function refundQuestion(playId: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(plays)
    .set({ questionsUsed: sql`${plays.questionsUsed} - 1` })
    .where(and(eq(plays.id, playId), gt(plays.questionsUsed, 0)));
}

// Reserves one unit of a daily budget in a single conditional UPDATE, so
// parallel requests cannot push a cap past its limit. The counter is advanced
// before the paid model call and is not given back when a call is declined, so
// the budget reflects calls attempted, not only answers stored. Returns false
// when the day's limit is already reached.
export async function reserveDaily(
  day: string,
  scope: string,
  limit: number
): Promise<boolean> {
  const db = await requireDb();
  // Make sure the row exists without disturbing an existing count.
  await db
    .insert(dailyUsage)
    .values({ day, scope, used: 0 })
    .onDuplicateKeyUpdate({ set: { day: sql`${dailyUsage.day}` } });
  const [result] = await db
    .update(dailyUsage)
    .set({ used: sql`${dailyUsage.used} + 1` })
    .where(
      and(
        eq(dailyUsage.day, day),
        eq(dailyUsage.scope, scope),
        lt(dailyUsage.used, limit)
      )
    );
  return result.affectedRows === 1;
}

// Hands a reserved unit back, used only when no model call was made (the game
// was already out of questions). A declined or failed call keeps its unit.
export async function releaseDaily(day: string, scope: string): Promise<void> {
  const db = await requireDb();
  await db
    .update(dailyUsage)
    .set({ used: sql`${dailyUsage.used} - 1` })
    .where(
      and(
        eq(dailyUsage.day, day),
        eq(dailyUsage.scope, scope),
        gt(dailyUsage.used, 0)
      )
    );
}

// Reads a daily counter without reserving, for the "is the Bureau open" gate.
export async function readDaily(day: string, scope: string): Promise<number> {
  const db = await requireDb();
  const [row] = await db
    .select({ used: dailyUsage.used })
    .from(dailyUsage)
    .where(and(eq(dailyUsage.day, day), eq(dailyUsage.scope, scope)));
  return row?.used ?? 0;
}

// Lightweight readiness probe: confirms a connection and a round-trip.
export async function pingDb(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

// The Bureau tables the app needs to serve games, inquiries and the inbox, and
// to hold furnished outcome events, the review log and subject disputes.
// dispute_records is from the most recent migration, so its presence doubles as
// a check that migrations ran to the current version.
const REQUIRED_TABLES = [
  "agents",
  "daily_usage",
  "dispute_records",
  "inquiries",
  "outcome_events",
  "outcome_reviews",
  "play_questions",
  "plays",
  "review_log_records",
  "review_log_sync",
] as const;

// Confirms the required schema is present, not just that the server answers.
// Migration failures at boot are caught and logged without stopping the
// process (see _core/index.ts), so a connection can succeed while the tables
// are missing; this is what readiness must catch.
export async function schemaReady(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    const result = await db.execute(
      sql`select count(*) as present from information_schema.tables
          where table_schema = database()
            and table_name in ('agents', 'daily_usage', 'dispute_records', 'inquiries', 'outcome_events', 'outcome_reviews', 'play_questions', 'plays', 'review_log_records', 'review_log_sync')`
    );
    const rows = (Array.isArray(result) ? result[0] : result) as unknown as Array<{
      present?: number | string;
    }>;
    return Number(rows?.[0]?.present ?? 0) === REQUIRED_TABLES.length;
  } catch {
    return false;
  }
}

export async function createAgent(agent: {
  name: string;
  builder: string;
  keyHash: string;
}): Promise<number> {
  const db = await requireDb();
  const [result] = await db.insert(agents).values(agent);
  return result.insertId;
}

export async function getAgentByKeyHash(keyHash: string) {
  const db = await requireDb();
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.keyHash, keyHash));
  return agent;
}

export async function listAgents() {
  const db = await requireDb();
  return db
    .select({
      id: agents.id,
      name: agents.name,
      builder: agents.builder,
      hidden: agents.hidden,
      createdAt: agents.createdAt,
      games: count(plays.id),
    })
    .from(agents)
    .leftJoin(plays, eq(plays.agentId, agents.id))
    .groupBy(agents.id)
    .orderBy(desc(agents.createdAt));
}

export async function setAgentHidden(id: number, hidden: boolean) {
  const db = await requireDb();
  await db.update(agents).set({ hidden }).where(eq(agents.id, id));
}

// Finished games for the scoreboard. Agent games from hidden agents are left
// out; human games carry no identity at all.
export async function listFinishedPlays(caseId: string) {
  const db = await requireDb();
  return db
    .select({
      agentId: plays.agentId,
      agentName: agents.name,
      agentBuilder: agents.builder,
      solved: plays.solved,
      questionsUsed: plays.questionsUsed,
      finishedAt: plays.finishedAt,
    })
    .from(plays)
    .leftJoin(agents, eq(agents.id, plays.agentId))
    .where(
      and(
        eq(plays.caseId, caseId),
        isNotNull(plays.finishedAt),
        sql`(${plays.agentId} is null or ${agents.hidden} = false)`
      )
    )
    .orderBy(asc(plays.finishedAt));
}

export async function addPlayQuestion(row: {
  playId: string;
  suspect: string;
  question: string;
  answer: string;
}): Promise<void> {
  const db = await requireDb();
  await db.insert(playQuestions).values(row);
}

// Records the one accusation. Returns false if the game was already closed.
export async function finishPlay(
  playId: string,
  accused: string,
  solved: boolean
): Promise<boolean> {
  const db = await requireDb();
  const [result] = await db
    .update(plays)
    .set({ accused, solved, finishedAt: new Date() })
    .where(and(eq(plays.id, playId), isNull(plays.finishedAt)));
  return result.affectedRows === 1;
}

// Furnished outcome events (see outcomeEvents in drizzle/schema.ts). Written
// only by the operator intake script; no route reads or writes them.
export async function findOutcomeEvent(furnisherId: string, eventId: string) {
  const db = await requireDb();
  const [row] = await db
    .select({
      id: outcomeEvents.id,
      packetId: outcomeEvents.packetId,
      signedEventHash: outcomeEvents.signedEventHash,
      evidenceResult: outcomeEvents.evidenceResult,
      expiredAt: outcomeEvents.expiredAt,
    })
    .from(outcomeEvents)
    .where(
      and(
        eq(outcomeEvents.furnisherId, furnisherId),
        eq(outcomeEvents.eventId, eventId)
      )
    );
  return row;
}

export async function insertOutcomeEvent(
  row: InsertOutcomeEvent
): Promise<void> {
  const db = await requireDb();
  await db.insert(outcomeEvents).values(row);
}

// Records a later proof check. Nothing else about a stored line changes when
// the same event is submitted again.
export async function updateOutcomeEventProof(
  id: number,
  proof: {
    proofOk: boolean;
    proofChecks: Record<string, unknown>;
    proofCheckedAt: Date;
  }
): Promise<void> {
  const db = await requireDb();
  await db.update(outcomeEvents).set(proof).where(eq(outcomeEvents.id, id));
}

const LINE_COLUMNS = {
  id: outcomeEvents.id,
  furnisherId: outcomeEvents.furnisherId,
  eventId: outcomeEvents.eventId,
  subjectRef: outcomeEvents.subjectRef,
  dataClass: outcomeEvents.dataClass,
  proofOk: outcomeEvents.proofOk,
  evidenceStatus: outcomeEvents.evidenceStatus,
  evidenceResult: outcomeEvents.evidenceResult,
  evidenceKey: outcomeEvents.evidenceKey,
  signedEventHash: outcomeEvents.signedEventHash,
  displayState: outcomeEvents.displayState,
  relationType: outcomeEvents.relationType,
  relationTargetEventId: outcomeEvents.relationTargetEventId,
};

// The columns compare without case under the server's default collation, but
// CounterAudit's event ids do not, so the two lookups below also match exactly.

// The subject dispute records on these lines (server/dispute.ts), each line
// with its own. A line with records also gets its signed event and receipt, which
// name the key a furnisher's record is checked against.
async function withDisputeRecords<T extends { id: number }>(
  rows: T[]
): Promise<
  Array<
    T & {
      disputeRecords: DisputeRecordRow[];
      signedEvent?: unknown;
      receipt?: unknown;
    }
  >
> {
  if (rows.length === 0) return [];
  const db = await requireDb();
  const records = await db
    .select()
    .from(disputeRecords)
    .where(inArray(disputeRecords.outcomeEventId, rows.map(r => r.id)))
    .orderBy(asc(disputeRecords.id));
  const disputed = [...new Set(records.map(r => r.outcomeEventId))];
  const keys = disputed.length
    ? await db
        .select({
          id: outcomeEvents.id,
          signedEvent: outcomeEvents.signedEvent,
          receipt: outcomeEvents.receipt,
        })
        .from(outcomeEvents)
        .where(inArray(outcomeEvents.id, disputed))
    : [];
  return rows.map(row => {
    const keyed = keys.find(k => k.id === row.id);
    return {
      ...row,
      disputeRecords: records.filter(r => r.outcomeEventId === row.id),
      ...(keyed ? { signedEvent: keyed.signedEvent, receipt: keyed.receipt } : {}),
    };
  });
}

// A stored line with what its states depend on (server/lineState.ts),
// including the subject's disputes on it.
export async function getOutcomeLine(
  furnisherId: string,
  eventId: string
): Promise<Line | undefined> {
  const db = await requireDb();
  const [row] = await db
    .select(LINE_COLUMNS)
    .from(outcomeEvents)
    .where(
      and(
        eq(outcomeEvents.furnisherId, furnisherId),
        eq(outcomeEvents.eventId, eventId)
      )
    );
  return row && row.furnisherId === furnisherId && row.eventId === eventId
    ? (await withDisputeRecords([row]))[0]
    : undefined;
}

// The same furnisher's lines whose relation points at this event, with when
// CounterAudit sealed each (a subject dispute's deadline compares with it).
export async function findRelatingOutcomeLines(
  furnisherId: string,
  eventId: string
): Promise<Line[]> {
  const db = await requireDb();
  const rows = await db
    .select({ ...LINE_COLUMNS, caCreatedAt: outcomeEvents.caCreatedAt })
    .from(outcomeEvents)
    .where(
      and(
        eq(outcomeEvents.furnisherId, furnisherId),
        eq(outcomeEvents.relationTargetEventId, eventId)
      )
    );
  return rows.filter(
    row =>
      row.furnisherId === furnisherId && row.relationTargetEventId === eventId
  );
}

export async function setOutcomeEventDisplayState(
  id: number,
  displayState: DisplayState
): Promise<void> {
  const db = await requireDb();
  await db
    .update(outcomeEvents)
    .set({ displayState })
    .where(eq(outcomeEvents.id, id));
}

// Another stored line that claims the same settlement log, if any.
export async function findOtherOutcomeEventWithEvidence(
  evidenceKey: string,
  furnisherId: string,
  eventId: string
): Promise<Line | undefined> {
  const db = await requireDb();
  const [row] = await db
    .select(LINE_COLUMNS)
    .from(outcomeEvents)
    .where(
      and(
        eq(outcomeEvents.evidenceKey, evidenceKey),
        or(
          ne(outcomeEvents.furnisherId, furnisherId),
          ne(outcomeEvents.eventId, eventId)
        )
      )
    )
    .limit(1);
  return row;
}

// Hands a line's settlement claim on, for a line that corrects or supersedes
// it (lineState takesOverClaim). Only clears the claim it was given.
export async function releaseEvidenceClaim(
  id: number,
  evidenceKey: string
): Promise<void> {
  const db = await requireDb();
  await db
    .update(outcomeEvents)
    .set({ evidenceKey: null })
    .where(
      and(eq(outcomeEvents.id, id), eq(outcomeEvents.evidenceKey, evidenceKey))
    );
}

// Records a later evidence check (server/evidence.ts).
export async function updateOutcomeEventEvidence(
  id: number,
  evidence: Pick<
    InsertOutcomeEvent,
    "evidenceStatus" | "evidenceResult" | "evidenceCheckedAt" | "evidenceKey"
  >
): Promise<void> {
  const db = await requireDb();
  await db.update(outcomeEvents).set(evidence).where(eq(outcomeEvents.id, id));
}

// Every stored line, with what the review queue shows (pnpm review) and the
// subject's disputes on it.
export async function listOutcomeLines() {
  const db = await requireDb();
  return withDisputeRecords(
    await db
      .select({
        ...LINE_COLUMNS,
        outcome: outcomeEvents.outcome,
        expiredAt: outcomeEvents.expiredAt,
      })
      .from(outcomeEvents)
      .orderBy(asc(outcomeEvents.id))
  );
}

// Every stored line, with what pnpm lines expire needs to judge its source
// (server/lineExpiry.ts).
export async function listExpiryLines() {
  const db = await requireDb();
  return db
    .select({
      ...LINE_COLUMNS,
      outcome: outcomeEvents.outcome,
      caCreatedAt: outcomeEvents.caCreatedAt,
      packetId: outcomeEvents.packetId,
      entryHash: outcomeEvents.entryHash,
      sequence: outcomeEvents.sequence,
      expiredAt: outcomeEvents.expiredAt,
    })
    .from(outcomeEvents)
    .orderBy(asc(outcomeEvents.id));
}

// Erases what a line says once its source has expired, and marks when. Only a
// row not erased already, so a second run changes nothing.
export async function eraseOutcomeEventContent(
  id: number,
  columns: Partial<InsertOutcomeEvent> & { expiredAt: Date }
): Promise<boolean> {
  const db = await requireDb();
  const [result] = await db
    .update(outcomeEvents)
    .set(columns)
    .where(and(eq(outcomeEvents.id, id), isNull(outcomeEvents.expiredAt)));
  return result.affectedRows === 1;
}

// Every stored line with its signed event, which an agent's file reads it
// from (server/agentFile.ts), and the subject's disputes on it.
export async function listFileLines() {
  const db = await requireDb();
  return withDisputeRecords(
    await db
      .select({
        ...LINE_COLUMNS,
        outcome: outcomeEvents.outcome,
        occurredAt: outcomeEvents.occurredAt,
        receivedAt: outcomeEvents.receivedAt,
        caCreatedAt: outcomeEvents.caCreatedAt,
        packetId: outcomeEvents.packetId,
        entryHash: outcomeEvents.entryHash,
        sequence: outcomeEvents.sequence,
        signedEvent: outcomeEvents.signedEvent,
        expiredAt: outcomeEvents.expiredAt,
      })
      .from(outcomeEvents)
      .orderBy(asc(outcomeEvents.id))
  );
}

const DISPUTE_LINE_COLUMNS = {
  ...LINE_COLUMNS,
  caCreatedAt: outcomeEvents.caCreatedAt,
  signedEvent: outcomeEvents.signedEvent,
  receipt: outcomeEvents.receipt,
  expiredAt: outcomeEvents.expiredAt,
};

// A line as pnpm dispute submit checks a record against it: what its states
// depend on, its signed event and receipt (the key that signed it), and its
// disputes. Matched exactly, as getOutcomeLine does.
export async function findDisputeLine(furnisherId: string, eventId: string) {
  const db = await requireDb();
  const [row] = await db
    .select(DISPUTE_LINE_COLUMNS)
    .from(outcomeEvents)
    .where(
      and(
        eq(outcomeEvents.furnisherId, furnisherId),
        eq(outcomeEvents.eventId, eventId)
      )
    );
  return row && row.furnisherId === furnisherId && row.eventId === eventId
    ? (await withDisputeRecords([row]))[0]
    : undefined;
}

// The same, by the line's id, as a dispute record names it.
export async function getDisputeLine(id: number) {
  const db = await requireDb();
  const [row] = await db
    .select(DISPUTE_LINE_COLUMNS)
    .from(outcomeEvents)
    .where(eq(outcomeEvents.id, id));
  return row ? (await withDisputeRecords([row]))[0] : undefined;
}

// Every stored record of one subject dispute, in the order they were stored.
export async function listDisputeRecords(
  disputeId: string
): Promise<DisputeRecordRow[]> {
  const db = await requireDb();
  return db
    .select()
    .from(disputeRecords)
    .where(eq(disputeRecords.disputeId, disputeId))
    .orderBy(asc(disputeRecords.id));
}

// Stores a sealed dispute record. Returns false when its packet is stored already.
export async function insertDisputeRecord(
  row: InsertDisputeRecord
): Promise<boolean> {
  const db = await requireDb();
  try {
    await db.insert(disputeRecords).values(row);
    return true;
  } catch (error) {
    const { code, cause } = error as { code?: string; cause?: { code?: string } };
    if ((code ?? cause?.code) !== "ER_DUP_ENTRY") throw error;
    return false;
  }
}

// The last pnpm review sync, or undefined before the first.
export async function getReviewLogSync(): Promise<ReviewLogSyncRow | undefined> {
  const db = await requireDb();
  const [row] = await db.select().from(reviewLogSync).where(eq(reviewLogSync.id, 1));
  return row;
}

// Records a pnpm review sync. A sync that stopped keeps the last success; one whose listing did
// not finish keeps the last complete count.
export async function recordReviewLogSync(sync: {
  at: Date;
  problem: string | null;
  listedCount: number | null;
}): Promise<void> {
  const db = await requireDb();
  const set = {
    lastAttemptAt: sync.at,
    problem: sync.problem ? sync.problem.slice(0, 500) : null,
    ...(sync.problem ? {} : { lastSuccessAt: sync.at }),
    ...(sync.listedCount === null ? {} : { listedCount: sync.listedCount, listedAt: sync.at }),
  };
  await db.insert(reviewLogSync).values({ id: 1, ...set }).onDuplicateKeyUpdate({ set });
}

// The review log's packets, in sequence order (server/reviewLog.ts).
export async function listReviewLogRecords(): Promise<ReviewLogRecordRow[]> {
  const db = await requireDb();
  return db.select().from(reviewLogRecords).orderBy(asc(reviewLogRecords.sequence));
}

// Stores packets read from the review log. A packet already stored is left as it was.
export async function insertReviewLogRecords(rows: InsertReviewLogRecord[]): Promise<number> {
  const db = await requireDb();
  let added = 0;
  for (const row of rows) {
    try {
      await db.insert(reviewLogRecords).values(row);
      added++;
    } catch (error) {
      const { code, cause } = error as { code?: string; cause?: { code?: string } };
      if ((code ?? cause?.code) !== "ER_DUP_ENTRY") throw error;
    }
  }
  return added;
}
