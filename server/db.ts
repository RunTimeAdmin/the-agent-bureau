import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertInquiry, inquiries } from "../drizzle/schema";

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
