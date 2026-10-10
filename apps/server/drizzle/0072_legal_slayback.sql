CREATE TABLE `git_commit_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`thread_id` text,
	`repo_path` text NOT NULL,
	`inputs_hash` text NOT NULL,
	`original_head` text,
	`branch` text,
	`state` text NOT NULL,
	`commit_sha` text,
	`rejection` text,
	`push_destination` text,
	`push_state` text NOT NULL,
	`push_failure` text,
	`prepared_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "git_commit_requests_state" CHECK("git_commit_requests"."state" IN ('prepared', 'committed', 'rejected', 'unknown')),
	CONSTRAINT "git_commit_requests_push_state" CHECK("git_commit_requests"."push_state" IN ('skipped', 'pending', 'pushed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_git_commit_requests_state` ON `git_commit_requests` (`state`);--> statement-breakpoint
CREATE INDEX `idx_git_commit_requests_prepared_at` ON `git_commit_requests` (`prepared_at`);