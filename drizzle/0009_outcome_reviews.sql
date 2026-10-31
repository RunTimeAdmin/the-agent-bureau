CREATE TABLE `outcome_reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`outcomeEventId` int NOT NULL,
	`reviewerId` varchar(36) NOT NULL,
	`decision` enum('approve','approve_with_waiver','reject') NOT NULL,
	`reason` varchar(500),
	`signedEventHash` varchar(64) NOT NULL,
	`decidedAt` datetime(3) NOT NULL,
	`recordedAt` datetime(3) NOT NULL,
	`decisionHash` varchar(64) NOT NULL,
	`signedDecision` json NOT NULL,
	CONSTRAINT `outcome_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `outcome_reviews_decisionHash_unique` UNIQUE(`decisionHash`)
);
--> statement-breakpoint
CREATE INDEX `outcome_reviews_event_idx` ON `outcome_reviews` (`outcomeEventId`);