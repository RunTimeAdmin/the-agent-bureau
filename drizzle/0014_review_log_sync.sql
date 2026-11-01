-- Where the operator's copy of the review log stands (pnpm review queue): one row
-- that pnpm review sync writes on every run.
CREATE TABLE `review_log_sync` (
	`id` int NOT NULL,
	`lastAttemptAt` datetime(3) NOT NULL,
	`lastSuccessAt` datetime(3),
	`listedCount` int,
	`listedAt` datetime(3),
	`problem` varchar(500),
	CONSTRAINT `review_log_sync_id` PRIMARY KEY(`id`)
);
