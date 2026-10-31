import {
  bigint,
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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
  table => [
    index("plays_agent_idx").on(table.agentId),
    // The scoreboard reads finished games of one case ordered by finish time.
    index("plays_case_finished_idx").on(table.caseId, table.finishedAt),
  ]
);

// Per-day budget counters. Each (day, scope) row is reserved with a single
// conditional UPDATE so concurrent requests cannot push a daily cap past its
// limit, and the reservation is made before the paid model call so a declined
// call still counts against the budget.
export const dailyUsage = mysqlTable(
  "daily_usage",
  {
    day: varchar("day", { length: 10 }).notNull(),
    scope: varchar("scope", { length: 48 }).notNull(),
    used: int("used").default(0).notNull(),
  },
  table => [primaryKey({ columns: [table.day, table.scope] })]
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

// Outcome event v1 values, as agent-bureau-furnish and CounterAudit define them.
export const OUTCOMES = [
  "paid",
  "refunded",
  "delivered",
  "disputed",
  "payment_failed",
  "not_delivered",
  "access_revoked",
  "policy_violation",
] as const;
export const RELATION_TYPES = [
  "disputes",
  "corrects",
  "supersedes",
  "withdraws",
] as const;
// How a line may be shown on a file (Phase 0 decision 4). Nothing sets
// "verified" yet: a passing proof and evidence check are recorded on the line,
// but the display rule also needs the review states and two-person review,
// which are not built, so every line is still "unverified".
export const DISPLAY_STATES = [
  "unverified",
  "verified",
  "disputed",
  "withdrawn",
  "superseded",
] as const;
// Results of an evidence check (server/evidence.ts, docs/evidence-verifier.md).
// "pending" and "error" are not verdicts: the check runs again later.
export const EVIDENCE_STATUSES = [
  "verified",
  "failed",
  "needs_review",
  "pending",
  "error",
] as const;

// One row per furnished outcome event sealed in CounterAudit, the system of
// record. The signed event is kept whole so its signature can be checked again;
// the other event columns are copies of its fields for querying. Three times
// stay apart (Phase 0 decision 7): occurredAt is the furnisher's claim, inside
// the signed event, and never independently trusted; receivedAt is when the
// Bureau read the event; caCreatedAt is CounterAudit's seal time. Event ids are
// unique per furnisher, as in CounterAudit.
//
// Times are DATETIME in UTC (getDb pins the session zone), not TIMESTAMP:
// occurredAt is the furnisher's choice and TIMESTAMP ends in 2038, and MariaDB
// before 10.10 (or MySQL with explicit_defaults_for_timestamp off) gives the
// first TIMESTAMP column ON UPDATE CURRENT_TIMESTAMP, which would rewrite the
// seal time whenever the proof check is refreshed.
export const outcomeEvents = mysqlTable(
  "outcome_events",
  {
    id: int("id").autoincrement().primaryKey(),
    furnisherId: varchar("furnisherId", { length: 36 }).notNull(),
    eventId: varchar("eventId", { length: 128 }).notNull(),
    keyId: varchar("keyId", { length: 64 }).notNull(),
    outcome: mysqlEnum("outcome", OUTCOMES).notNull(),
    subjectRef: json("subjectRef").$type<Record<string, unknown>>().notNull(),
    occurredAt: datetime("occurredAt", { fsp: 3 }).notNull(),
    relationType: mysqlEnum("relationType", RELATION_TYPES),
    relationTargetEventId: varchar("relationTargetEventId", { length: 128 }),
    signedEvent: json("signedEvent").$type<Record<string, unknown>>().notNull(),
    // SHA-256 of the RFC 8785 canonical signed event, signature included.
    signedEventHash: varchar("signedEventHash", { length: 64 }).notNull(),
    packetId: varchar("packetId", { length: 36 }).notNull().unique(),
    entryHash: varchar("entryHash", { length: 64 }).notNull(),
    sequence: bigint("sequence", { mode: "number" }),
    caCreatedAt: datetime("caCreatedAt", { fsp: 3 }).notNull(),
    receivedAt: datetime("receivedAt", { fsp: 3 }).notNull(),
    // CounterAudit's signed receipt from ingest; null if it sent none.
    receipt: json("receipt").$type<Record<string, unknown>>(),
    // The last check of the packet's public proof: whether every check passed,
    // each check's result, and when it ran. The last two stay null until a
    // check has run.
    proofOk: boolean("proofOk").default(false).notNull(),
    proofChecks: json("proofChecks").$type<Record<string, unknown>>(),
    proofCheckedAt: datetime("proofCheckedAt", { fsp: 3 }),
    // The last evidence check: its status, the full result, and when it ran;
    // null until a check has run. evidenceKey is the settlement log this line
    // claims (chain id, transaction, log index), so one charge cannot back two
    // lines unnoticed. It is set only once the proof passed and the charge's
    // merchant is the furnisher's vetted account, and never cleared.
    evidenceStatus: mysqlEnum("evidenceStatus", EVIDENCE_STATUSES),
    evidenceResult: json("evidenceResult").$type<Record<string, unknown>>(),
    evidenceCheckedAt: datetime("evidenceCheckedAt", { fsp: 3 }),
    evidenceKey: varchar("evidenceKey", { length: 96 }),
    displayState: mysqlEnum("displayState", DISPLAY_STATES)
      .default("unverified")
      .notNull(),
    // "test" until retention is signed off; intake writes nothing else.
    dataClass: mysqlEnum("dataClass", ["test", "live"]).notNull(),
  },
  table => [
    uniqueIndex("outcome_events_furnisher_event_uq").on(
      table.furnisherId,
      table.eventId
    ),
    index("outcome_events_evidence_key_idx").on(table.evidenceKey),
  ]
);

export type OutcomeEvent = typeof outcomeEvents.$inferSelect;
export type InsertOutcomeEvent = typeof outcomeEvents.$inferInsert;

export type Agent = typeof agents.$inferSelect;
export type Play = typeof plays.$inferSelect;
export type PlayQuestion = typeof playQuestions.$inferSelect;
export type DailyUsage = typeof dailyUsage.$inferSelect;
