CREATE TABLE `review_log_moves` (
	`id` int AUTO_INCREMENT NOT NULL,
	`fromOrgId` varchar(36),
	`toOrgId` varchar(36) NOT NULL,
	`fromPackets` int NOT NULL,
	`fromCheckpointSequence` int,
	`fromCheckpointEntryHash` varchar(64),
	`pinnedGenesis` varchar(64),
	`movedAt` datetime(3) NOT NULL,
	CONSTRAINT `review_log_moves_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `review_log_sync` ADD `orgId` varchar(36);
--> statement-breakpoint
-- A copy made before this migration holds the organization pinned when it runs (REVIEW_ORG_ID).
UPDATE `review_log_sync` SET `orgId` = 'ad7b94fc-05be-45e6-9124-62f576f2d812' WHERE `id` = 1;