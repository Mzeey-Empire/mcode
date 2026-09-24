CREATE TABLE `canonical_writer_operation_receipts` (
	`execution_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`input_hash` text NOT NULL,
	`receipt_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`execution_id`, `operation_id`),
	FOREIGN KEY (`execution_id`) REFERENCES `canonical_agent_turns`(`execution_id`) ON UPDATE no action ON DELETE cascade
);
