CREATE TABLE `plan_implement_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`source_thread_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`version_id` text NOT NULL,
	`version` integer NOT NULL,
	`revision` integer NOT NULL,
	`title` text NOT NULL,
	`wire_text` text NOT NULL,
	`target` text NOT NULL,
	`source_commit` text,
	`target_thread_id` text,
	`startup_id` text,
	`message_id` text NOT NULL,
	`status` text NOT NULL,
	`failure_code` text,
	`native_plan_file_json` text,
	`turn_id` text,
	`execution_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`source_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plan_implement_preparing_thread` ON `plan_implement_requests` (`source_thread_id`) WHERE "plan_implement_requests"."status" = 'preparing';