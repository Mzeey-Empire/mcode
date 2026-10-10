DROP TABLE `diff_summaries`;--> statement-breakpoint
ALTER TABLE `canonical_agent_turns` ADD `attempt_of` text;--> statement-breakpoint
CREATE INDEX `idx_canonical_agent_turns_attempt_of` ON `canonical_agent_turns` (`attempt_of`);