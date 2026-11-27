CREATE TABLE IF NOT EXISTS `workspace_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`source_path` text NOT NULL,
	`destination_path` text NOT NULL,
	`staging_path` text,
	`init_git` integer NOT NULL,
	`phase` text NOT NULL,
	`revision` integer NOT NULL,
	`result` text,
	`cleanup` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_workspace_moves_unfinished` ON `workspace_moves` (`workspace_id`) WHERE `workspace_moves`.`phase` <> 'done';
--> statement-breakpoint
INSERT INTO `mcode_schema_compatibility` (`id`, `floor_when`, `raised_by`) VALUES (1, 1795715755958, '0116_workspace_moves') ON CONFLICT(`id`) DO UPDATE SET `floor_when` = max(`floor_when`, excluded.`floor_when`), `raised_by` = CASE WHEN excluded.`floor_when` > `floor_when` THEN excluded.`raised_by` ELSE `raised_by` END;
