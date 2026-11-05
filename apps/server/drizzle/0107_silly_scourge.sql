CREATE INDEX IF NOT EXISTS `idx_canonical_agent_checkpoints_turn_terminal` ON `canonical_agent_ingest_checkpoints` (`turn_id`,`terminal_outcome`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canonical_agent_items_turn_kind` ON `canonical_agent_items` (`turn_id`,`kind`,`created_at`);
