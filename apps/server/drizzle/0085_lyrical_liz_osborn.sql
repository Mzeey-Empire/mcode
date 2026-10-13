CREATE TABLE `approval_notes` (
	`request_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`note` text NOT NULL,
	`delivery` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
