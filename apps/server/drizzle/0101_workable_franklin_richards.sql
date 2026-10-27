CREATE TABLE IF NOT EXISTS `thread_pull_requests` (
	`thread_id` text NOT NULL,
	`number` integer NOT NULL,
	`state` text NOT NULL,
	`title` text,
	`url` text,
	`observed_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `number`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_thread_pull_requests_state` ON `thread_pull_requests` (`state`,`thread_id`);
