CREATE TABLE `approval_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`tool_call_id` text,
	`kind` text NOT NULL,
	`subject_label` text NOT NULL,
	`outcome` text NOT NULL,
	`origin` text,
	`decided_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_approval_receipts_message_sort_order_id` ON `approval_receipts` (`message_id`,`sort_order`,`id`);