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