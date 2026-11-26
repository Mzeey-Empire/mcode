CREATE TABLE IF NOT EXISTS `thread_move_worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `mcode_schema_compatibility` (`id`, `floor_when`, `raised_by`) VALUES (1, 1795715755957, '0115_thread_move_worktrees') ON CONFLICT(`id`) DO UPDATE SET `floor_when` = max(`floor_when`, excluded.`floor_when`), `raised_by` = CASE WHEN excluded.`floor_when` > `floor_when` THEN excluded.`raised_by` ELSE `raised_by` END;
