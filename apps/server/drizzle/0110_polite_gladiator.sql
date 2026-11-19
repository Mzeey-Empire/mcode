ALTER TABLE `thread_startups` ADD `failure_seen_at` text;
--> statement-breakpoint
UPDATE `thread_startups` SET `failure_seen_at` = `updated_at` WHERE `state` IN ('failed', 'interrupted');
