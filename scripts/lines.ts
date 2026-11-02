// Stored lines: erase the Bureau's copy of each line whose CounterAudit source
// has expired, or seal the stored evidence result of each line that has never
// had one sealed. Usage: pnpm lines expire [--dry-run]
//                        pnpm lines seal-evidence [--dry-run]
// See docs/agent-file.md, "When a line's source expires".
import "dotenv/config";
import { closeDb } from "../server/db";
import { runLines } from "../server/lineExpiry";

try {
  process.exitCode = await runLines(process.argv.slice(2));
} finally {
  await closeDb();
}
