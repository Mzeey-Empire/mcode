CREATE TABLE IF NOT EXISTS `thread_provider_sessions` (
	`thread_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`session_id` text NOT NULL,
	`last_seen_sequence` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `provider_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT OR IGNORE INTO `thread_provider_sessions` (`thread_id`, `provider_id`, `session_id`, `last_seen_sequence`, `updated_at`)
SELECT `t`.`id`, `t`.`provider`, `t`.`sdk_session_id`, COALESCE((SELECT MAX(`m`.`sequence`) FROM `messages` `m` WHERE `m`.`thread_id` = `t`.`id`), 0), `t`.`updated_at`
FROM `threads` `t`
WHERE `t`.`sdk_session_id` IS NOT NULL AND `t`.`sdk_session_id` <> '' AND `t`.`provider` IS NOT NULL;
