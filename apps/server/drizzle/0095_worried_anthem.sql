CREATE TABLE IF NOT EXISTS `delegated_tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`coordinator_thread_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`plan_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`coordinator_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_delegated_tasks_coordinator_request` ON `delegated_tasks` (`coordinator_thread_id`,`client_request_id`);
--> statement-breakpoint
UPDATE threads SET delegation_coordinator_thread_id = NULL
WHERE delegation_creation_kind = 'thread_delegation';
