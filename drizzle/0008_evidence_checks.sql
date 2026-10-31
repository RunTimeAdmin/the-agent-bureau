ALTER TABLE `outcome_events` ADD `evidenceStatus` enum('verified','failed','needs_review','pending','error');--> statement-breakpoint
ALTER TABLE `outcome_events` ADD `evidenceResult` json;--> statement-breakpoint
ALTER TABLE `outcome_events` ADD `evidenceCheckedAt` datetime(3);--> statement-breakpoint
ALTER TABLE `outcome_events` ADD `evidenceKey` varchar(96);--> statement-breakpoint
CREATE INDEX `outcome_events_evidence_key_idx` ON `outcome_events` (`evidenceKey`);