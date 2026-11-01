-- Subject disputes (docs/disputes.md): every sealed dispute record, and 'removed' for a line
-- whose dispute lapsed. The enum only gains a value, before anything can write it.
ALTER TABLE `outcome_events` MODIFY COLUMN `displayState` enum('unverified','released','disputed','withdrawn','superseded','removed') NOT NULL DEFAULT 'unverified';--> statement-breakpoint
CREATE TABLE `dispute_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`disputeId` varchar(36) NOT NULL,
	`kind` enum('dispute','response','statement','appeal') NOT NULL,
	`outcomeEventId` int NOT NULL,
	`record` json,
	`packetId` varchar(36) NOT NULL,
	`sequence` bigint,
	`sealedAt` datetime(3) NOT NULL,
	`receipt` json,
	`signatureOk` boolean NOT NULL,
	`subjectControlOk` boolean,
	`checkProblem` varchar(500),
	`controllerAddress` varchar(42),
	CONSTRAINT `dispute_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `dispute_records_packetId_unique` UNIQUE(`packetId`)
);
--> statement-breakpoint
CREATE INDEX `dispute_records_dispute_idx` ON `dispute_records` (`disputeId`);--> statement-breakpoint
CREATE INDEX `dispute_records_line_idx` ON `dispute_records` (`outcomeEventId`);