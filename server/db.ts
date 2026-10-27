import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import {
  InsertInquiry,
  agents,
  inquiries,
  playQuestions,
  plays,
} from "../drizzle/schema";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
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

// Humans and agents draw on separate daily budgets, so agents can't use up
// the questions meant for people playing in the browser.
export async function countQuestionsSince(
  since: Date,
  byAgents: boolean
): Promise<number> {
  const db = await requireDb();
  const [row] = await db
    .select({ total: count() })
    .from(playQuestions)
    .innerJoin(plays, eq(plays.id, playQuestions.playId))
    .where(
      and(
        gte(playQuestions.createdAt, since),
        byAgents ? isNotNull(plays.agentId) : isNull(plays.agentId)
      )
    );
  return row?.total ?? 0;
}

export async function countAgentUsageSince(agentId: number, since: Date) {
  const db = await requireDb();
  const [games] = await db
    .select({ total: count() })
    .from(plays)
    .where(and(eq(plays.agentId, agentId), gte(plays.startedAt, since)));
  const [questions] = await db
    .select({ total: count() })
    .from(playQuestions)
    .innerJoin(plays, eq(plays.id, playQuestions.playId))
    .where(
      and(eq(plays.agentId, agentId), gte(playQuestions.createdAt, since))
    );
  return { games: games?.total ?? 0, questions: questions?.total ?? 0 };
}

export async function countAgentsSince(since: Date): Promise<number> {
  const db = await requireDb();
  const [row] = await db
    .select({ total: count() })
    .from(agents)
    .where(gte(agents.createdAt, since));
  return row?.total ?? 0;
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
