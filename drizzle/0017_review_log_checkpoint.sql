ALTER TABLE `review_log_sync` ADD `checkpointSequence` int;--> statement-breakpoint
ALTER TABLE `review_log_sync` ADD `checkpointEntryHash` varchar(64);--> statement-breakpoint
ALTER TABLE `review_log_sync` ADD `checkpointIssuedAt` datetime(3);