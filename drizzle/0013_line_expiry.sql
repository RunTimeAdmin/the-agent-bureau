-- A line expires with its CounterAudit source (decision of 1 November 2026):
-- pnpm lines expire empties what the row says about the subject and sets
-- expiredAt, so the content columns it empties must take NULL.
ALTER TABLE `outcome_events` MODIFY COLUMN `subjectRef` json;--> statement-breakpoint
ALTER TABLE `outcome_events` MODIFY COLUMN `signedEvent` json;--> statement-breakpoint
ALTER TABLE `outcome_events` ADD `expiredAt` datetime(3);