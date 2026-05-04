CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`provider_config` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`last_opened_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_git_repo` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_path_unique` ON `workspaces` (`path`);--> statement-breakpoint
CREATE INDEX `idx_workspaces_sort_order` ON `workspaces` ("sort_order" asc);--> statement-breakpoint
CREATE INDEX `idx_workspaces_pinned_last_opened` ON `workspaces` ("pinned" desc,"last_opened_at" desc);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`mode` text DEFAULT 'direct' NOT NULL,
	`worktree_path` text,
	`branch` text NOT NULL,
	`issue_number` integer,
	`pr_number` integer,
	`pr_status` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deleted_at` text,
	`model` text,
	`worktree_managed` integer DEFAULT 1 NOT NULL,
	`sdk_session_id` text,
	`last_context_tokens` integer,
	`context_window` integer,
	`provider` text DEFAULT 'claude' NOT NULL,
	`reasoning_level` text,
	`interaction_mode` text,
	`permission_mode` text,
	`parent_thread_id` text,
	`forked_from_message_id` text,
	`last_compact_summary` text,
	`copilot_agent` text,
	`context_window_mode` text,
	`thinking` integer,
	`has_file_changes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_threads_workspace` ON `threads` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `idx_threads_status` ON `threads` (`status`);--> statement-breakpoint
CREATE INDEX `idx_threads_parent_thread_id` ON `threads` (`parent_thread_id`);--> statement-breakpoint
CREATE INDEX `idx_threads_forked_from_message_id` ON `threads` (`forked_from_message_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`files_changed` text,
	`cost_usd` real,
	`tokens_used` integer,
	`timestamp` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`sequence` integer NOT NULL,
	`attachments` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_sequence` ON `messages` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `tool_call_records` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`parent_tool_call_id` text,
	`tool_name` text NOT NULL,
	`input_summary` text DEFAULT '' NOT NULL,
	`output_summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tool_call_records_message` ON `tool_call_records` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_call_records_parent` ON `tool_call_records` (`parent_tool_call_id`);--> statement-breakpoint
CREATE TABLE `turn_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`ref_before` text NOT NULL,
	`ref_after` text NOT NULL,
	`files_changed` text DEFAULT '[]' NOT NULL,
	`worktree_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_turn_snapshots_message` ON `turn_snapshots` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_snapshots_thread` ON `turn_snapshots` (`thread_id`);--> statement-breakpoint
CREATE TABLE `thread_tasks` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`tasks_json` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cleanup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_path` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cleanup_jobs_thread_id_unique` ON `cleanup_jobs` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_cleanup_jobs_retry` ON `cleanup_jobs` (`next_retry_at`,`attempts`,`created_at`);--> statement-breakpoint
CREATE TABLE `provider_model_cache` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`models_json` text NOT NULL,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL,
	`model_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_question_answers` (
	`assistant_message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`answered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_plan_question_answers_thread` ON `plan_question_answers` (`thread_id`);
