ALTER TABLE `workspace_moves` ADD `claim_released` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspace_moves` ADD `copied_bytes` integer;
--> statement-breakpoint
ALTER TABLE `workspace_moves` ADD `total_bytes` integer;
--> statement-breakpoint
ALTER TABLE `workspace_moves` ADD `source_retain_until` text;
--> statement-breakpoint
ALTER TABLE `workspace_moves` ADD `tombstone_path` text;
--> statement-breakpoint
ALTER TABLE `workspace_moves` ADD `delete_staging_started` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `workspace_moves` ADD `cleanup_error` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_move_manifests` (
	`move_id` text PRIMARY KEY NOT NULL REFERENCES `workspace_moves`(`id`) ON DELETE cascade,
	`entries` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `mcode_schema_compatibility` (`id`, `floor_when`, `raised_by`) VALUES (1, 1795715755959, '0117_workspace_move_copy') ON CONFLICT(`id`) DO UPDATE SET `floor_when` = max(`floor_when`, excluded.`floor_when`), `raised_by` = CASE WHEN excluded.`floor_when` > `floor_when` THEN excluded.`raised_by` ELSE `raised_by` END;
