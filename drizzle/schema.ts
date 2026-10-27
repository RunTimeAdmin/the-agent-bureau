import {
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
/**
 * Columns use camelCase to match both database fields and generated types.
 */
export const inquiries = mysqlTable("inquiries", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  email: varchar("email", { length: 320 }).notNull(),
  // The first three values belong to the retired services pitch. They stay
  // so older rows remain valid; the form only offers the last four.
  interest: mysqlEnum("interest", [
    "Hire an agent",
    "Become a provider",
    "Partnership",
    "General inquiry",
    "Report agent outcomes",
    "Request a Bureau file",
    "I operate an agent",
  ]).notNull(),
  message: text("message").notNull(),
  reference: varchar("reference", { length: 48 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  status: mysqlEnum("status", ["new", "reviewed", "closed"])
    .default("new")
    .notNull(),
});

export type Inquiry = typeof inquiries.$inferSelect;
export type InsertInquiry = typeof inquiries.$inferInsert;

// Agents registered for agent mode. Only a SHA-256 hash of each API key is
// stored. Game data only: nothing here feeds a Bureau file, and no Bureau
// data feeds a game score.
export const agents = mysqlTable("agents", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 40 }).notNull().unique(),
  builder: varchar("builder", { length: 40 }).notNull(),
  keyHash: varchar("keyHash", { length: 64 }).notNull().unique(),
  hidden: boolean("hidden").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// One row per game. The id is a random token the player holds, so it doubles
// as the credential for that game. agentId is set when an agent plays.
export const plays = mysqlTable(
  "plays",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    caseId: varchar("caseId", { length: 16 }).notNull(),
    agentId: int("agentId"),
    questionsUsed: int("questionsUsed").default(0).notNull(),
    accused: varchar("accused", { length: 16 }),
    solved: boolean("solved"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    finishedAt: timestamp("finishedAt"),
  },
  table => [index("plays_agent_idx").on(table.agentId)]
);

export const playQuestions = mysqlTable(
  "play_questions",
  {
    id: int("id").autoincrement().primaryKey(),
    playId: varchar("playId", { length: 32 }).notNull(),
    suspect: varchar("suspect", { length: 16 }).notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("play_questions_play_idx").on(table.playId)]
);

export type Agent = typeof agents.$inferSelect;
export type Play = typeof plays.$inferSelect;
export type PlayQuestion = typeof playQuestions.$inferSelect;
