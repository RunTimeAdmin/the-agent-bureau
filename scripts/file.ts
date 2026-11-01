// Agents' files: assemble one, signed with a pinned Bureau key, or verify one.
// Usage: pnpm file <keygen|assemble|verify> ...
// See docs/agent-file.md.
import "dotenv/config";
import { closeDb } from "../server/db";
import { runFile } from "../server/agentFile";

try {
  process.exitCode = await runFile(process.argv.slice(2));
} finally {
  await closeDb();
}
