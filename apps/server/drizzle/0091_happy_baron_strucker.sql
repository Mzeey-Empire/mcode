ALTER TABLE `workspace_environment_automatic_setup_attempts` ADD `failed_action_id` text;--> statement-breakpoint
ALTER TABLE `workspace_environment_automatic_setup_attempts` DROP COLUMN `launch_snapshot_json`;--> statement-breakpoint
ALTER TABLE `workspace_environment_automatic_setup_attempts` DROP COLUMN `outcome`;--> statement-breakpoint
ALTER TABLE `workspace_environment_automatic_setup_attempts` DROP COLUMN `exit_code`;--> statement-breakpoint
ALTER TABLE `workspace_environment_automatic_setup_attempts` DROP COLUMN `output`;--> statement-breakpoint
ALTER TABLE `workspace_environment_automatic_setup_attempts` DROP COLUMN `output_truncated`;
--> statement-breakpoint
DELETE FROM `workspace_environment_command_approvals` WHERE `command_id` = 'setup';
