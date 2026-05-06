DROP INDEX `idx_diff_summaries_thread`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_diff_summaries_thread` ON `diff_summaries` (`thread_id`);