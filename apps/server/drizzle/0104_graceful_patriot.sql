CREATE TABLE IF NOT EXISTS `canonical_agent_item_content_appends` (
	`item_id` text NOT NULL,
	`offset` integer NOT NULL,
	`text_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`item_id`, `offset`),
	FOREIGN KEY (`item_id`) REFERENCES `canonical_agent_items`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID;
