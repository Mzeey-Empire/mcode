CREATE TABLE `hook_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`hook_name` text NOT NULL,
	`tool_name` text,
	`phase` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`duration_ms` integer,
	`did_block` integer DEFAULT 0 NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`ended_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hook_executions_message` ON `hook_executions` (`message_id`);--> statement-breakpoint
CREATE TABLE `thought_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`text` text NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`ended_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_thought_segments_message` ON `thought_segments` (`message_id`);