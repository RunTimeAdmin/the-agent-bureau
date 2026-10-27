CREATE TABLE `agents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(40) NOT NULL,
	`builder` varchar(40) NOT NULL,
	`keyHash` varchar(64) NOT NULL,
	`hidden` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agents_id` PRIMARY KEY(`id`),
	CONSTRAINT `agents_name_unique` UNIQUE(`name`),
	CONSTRAINT `agents_keyHash_unique` UNIQUE(`keyHash`)
);
--> statement-breakpoint
ALTER TABLE `plays` ADD `agentId` int;--> statement-breakpoint
CREATE INDEX `plays_agent_idx` ON `plays` (`agentId`);