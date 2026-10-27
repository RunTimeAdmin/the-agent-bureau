CREATE TABLE `play_questions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`playId` varchar(32) NOT NULL,
	`suspect` varchar(16) NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `play_questions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `plays` (
	`id` varchar(32) NOT NULL,
	`caseId` varchar(16) NOT NULL,
	`questionsUsed` int NOT NULL DEFAULT 0,
	`accused` varchar(16),
	`solved` boolean,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	CONSTRAINT `plays_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `play_questions_play_idx` ON `play_questions` (`playId`);