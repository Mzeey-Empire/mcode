CREATE TABLE `turn_reverts` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`request_params` text NOT NULL,
	`thread_id` text NOT NULL,
	`target_message_id` text NOT NULL,
	`from_message_id` text,
	`kind` text NOT NULL,
	`path` text,
	`undoes_revert_id` text,
	`undone_by_revert_id` text,
	`state` text NOT NULL,
	`files` text NOT NULL,
	`recovery_ref` text,
	`failure` text,
	`receipt_message_id` text,
	`agent_notified_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`undoes_revert_id`) REFERENCES `turn_reverts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`receipt_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_reverts_request_id_unique` ON `turn_reverts` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_reverts_thread` ON `turn_reverts` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_turn_reverts_target` ON `turn_reverts` (`target_message_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_reverts_unfinished` ON `turn_reverts` (`state`) WHERE "turn_reverts"."state" IN ('prepared', 'recovery_failed');