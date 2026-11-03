CREATE TABLE `login_attempts` (
	`key` varchar(64) NOT NULL,
	`windowStartedAt` bigint NOT NULL,
	`count` int NOT NULL,
	CONSTRAINT `login_attempts_key` PRIMARY KEY(`key`)
);--> statement-breakpoint
CREATE INDEX `login_attempts_window_idx` ON `login_attempts` (`windowStartedAt`);--> statement-breakpoint
-- Review AB-03: an erased line keeps no evidence status. Lines erased from now on are cleared as
-- they are erased (server/lineExpiry.ts); this clears the ones erased before.
UPDATE `outcome_events` SET `evidenceStatus` = NULL WHERE `expiredAt` IS NOT NULL;
