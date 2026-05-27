ALTER TABLE `thought_segments` RENAME TO `narration_segments`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_thought_segments_message`;--> statement-breakpoint
CREATE INDEX `idx_narration_segments_message` ON `narration_segments` (`message_id`);