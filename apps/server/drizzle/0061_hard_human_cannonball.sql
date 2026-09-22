CREATE TABLE `canonical_conversation_display_mappings` (
	`source_item_id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`source_item_id`) REFERENCES `canonical_agent_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_conversation_display_mappings_target` ON `canonical_conversation_display_mappings` (`target_kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `conversation_display_materialization_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_source_created_at` text,
	`last_source_id` text,
	`completed` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `parent_agent_provenance` text;--> statement-breakpoint
CREATE INDEX `idx_messages_thread_sequence_id` ON `messages` (`thread_id`,`sequence`,`id`);--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_items_created_id` ON `canonical_agent_items` (`created_at`,`id`);