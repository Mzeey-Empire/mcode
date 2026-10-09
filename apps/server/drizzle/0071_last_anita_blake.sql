CREATE TABLE `__new_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`content_md` text NOT NULL,
	`author` text NOT NULL,
	`provider_id` text,
	`capture_source` text NOT NULL,
	`base_version_id` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`native_plan_file_json` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`accepted_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_plans`("id", "thread_id", "message_id", "version", "title", "content_md", "author", "provider_id", "capture_source", "base_version_id", "revision", "native_plan_file_json", "status", "created_at", "updated_at", "accepted_at") SELECT "id", "thread_id", "message_id", "version", "title", "content_md", 'agent', NULL, 'fence', NULL, 0, NULL, CASE WHEN "status" = 'draft' THEN 'ready' ELSE "status" END, "created_at", "created_at", NULL FROM `plans`;--> statement-breakpoint
DROP TABLE `plans`;--> statement-breakpoint
ALTER TABLE `__new_plans` RENAME TO `plans`;--> statement-breakpoint
CREATE INDEX `idx_plans_thread` ON `plans` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plans_thread_version` ON `plans` (`thread_id`,`version`);
