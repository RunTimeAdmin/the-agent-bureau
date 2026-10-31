// Two-person review of stored outcome lines.
// Usage: pnpm review <keygen|sign|queue|apply|settle> ...
// See docs/two-person-review.md.
import "dotenv/config";
import { closeDb } from "../server/db";
import { runReview } from "../server/review";

try {
  process.exitCode = await runReview(process.argv.slice(2));
} finally {
  await closeDb();
}
