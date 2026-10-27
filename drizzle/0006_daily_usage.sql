CREATE TABLE `daily_usage` (
	`day` varchar(10) NOT NULL,
	`scope` varchar(48) NOT NULL,
	`used` int NOT NULL DEFAULT 0,
	CONSTRAINT `daily_usage_day_scope_pk` PRIMARY KEY(`day`,`scope`)
);
--> statement-breakpoint
CREATE INDEX `plays_case_finished_idx` ON `plays` (`caseId`,`finishedAt`);