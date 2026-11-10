CREATE TABLE IF NOT EXISTS `turn_file_evidence` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`state` text NOT NULL,
	`evidence_json` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`execution_id`) REFERENCES `canonical_agent_ingest_checkpoints`(`execution_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_turn_file_evidence_thread` ON `turn_file_evidence` (`thread_id`);
