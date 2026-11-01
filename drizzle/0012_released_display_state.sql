-- Review finding M-04: a line reviewers released shows as 'released', not
-- 'verified'. The enum first takes both names, stored lines move to the new
-- one, and only then is the old name dropped, so no row is ever left with a
-- value the column refuses.
ALTER TABLE `outcome_events` MODIFY COLUMN `displayState` enum('unverified','verified','released','disputed','withdrawn','superseded') NOT NULL DEFAULT 'unverified';--> statement-breakpoint
UPDATE `outcome_events` SET `displayState` = 'released' WHERE `displayState` = 'verified';--> statement-breakpoint
ALTER TABLE `outcome_events` MODIFY COLUMN `displayState` enum('unverified','released','disputed','withdrawn','superseded') NOT NULL DEFAULT 'unverified';
