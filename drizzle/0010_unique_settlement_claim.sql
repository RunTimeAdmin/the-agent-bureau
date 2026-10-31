-- One settlement log backs at most one line (review M-02). Before the unique
-- index, any second line already holding a claimed charge loses its claim and
-- its evidence fails, keeping the earliest holder; then the unique index is
-- added, and only then the plain one dropped, so a failure part way leaves the
-- old index in place.
UPDATE `outcome_events` o
JOIN (
	SELECT `evidenceKey` AS k, MIN(`id`) AS keep_id
	FROM `outcome_events`
	WHERE `evidenceKey` IS NOT NULL
	GROUP BY `evidenceKey`
	HAVING COUNT(*) > 1
) d ON o.`evidenceKey` = d.k AND o.`id` <> d.keep_id
SET o.`evidenceStatus` = 'failed',
	o.`evidenceResult` = JSON_SET(
		JSON_ARRAY_APPEND(o.`evidenceResult`, '$.reasons', 'the same charge already backs another line (migration 0010)'),
		'$.status', 'failed'
	),
	o.`evidenceKey` = NULL;--> statement-breakpoint
ALTER TABLE `outcome_events` ADD CONSTRAINT `outcome_events_evidence_key_uq` UNIQUE(`evidenceKey`);--> statement-breakpoint
DROP INDEX `outcome_events_evidence_key_idx` ON `outcome_events`;
