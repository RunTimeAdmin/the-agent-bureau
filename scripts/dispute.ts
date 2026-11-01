// Disputes from the subject: sign a record (testing only), seal and record
// one, or close lapsed disputes.
// Usage: pnpm dispute <sign|submit|settle> ...
// See docs/disputes.md.
import "dotenv/config";
import { closeDb } from "../server/db";
import { runDispute } from "../server/disputeCommand";

try {
  process.exitCode = await runDispute(process.argv.slice(2));
} finally {
  await closeDb();
}
