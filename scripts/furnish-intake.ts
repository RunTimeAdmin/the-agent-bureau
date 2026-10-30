// Operator intake of signed outcome events into CounterAudit, test data only.
// Usage: pnpm furnish:intake --test-data <signed.jsonl>
// See docs/counteraudit-intake.md.
import "dotenv/config";
import { closeDb } from "../server/db";
import { runIntake } from "../server/furnishIntake";

try {
  process.exitCode = await runIntake(process.argv.slice(2));
} finally {
  await closeDb();
}
