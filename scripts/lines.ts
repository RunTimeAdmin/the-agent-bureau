// Stored lines: erase the Bureau's copy of each line whose CounterAudit source
// has expired. Usage: pnpm lines expire [--dry-run]
// See docs/agent-file.md, "When a line's source expires".
import "dotenv/config";
import { closeDb } from "../server/db";
import { runLines } from "../server/lineExpiry";

try {
  process.exitCode = await runLines(process.argv.slice(2));
} finally {
  await closeDb();
}
