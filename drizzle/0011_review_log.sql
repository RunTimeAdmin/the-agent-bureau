CREATE TABLE `review_log_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sequence` int NOT NULL,
	`packetId` varchar(36) NOT NULL,
	`prevHash` varchar(64) NOT NULL,
	`entryHash` varchar(64) NOT NULL,
	`connectorId` varchar(64) NOT NULL,
	`sealedAt` datetime(3) NOT NULL,
	`record` json,
	`readAt` datetime(3) NOT NULL,
	CONSTRAINT `review_log_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `review_log_records_sequence_unique` UNIQUE(`sequence`),
	CONSTRAINT `review_log_records_packetId_unique` UNIQUE(`packetId`)
);
