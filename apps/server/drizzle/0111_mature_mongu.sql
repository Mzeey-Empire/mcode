CREATE TABLE IF NOT EXISTS `background_command_awaits` (
	`thread_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`awaited_at` text NOT NULL,
	PRIMARY KEY(`thread_id`, `tool_call_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
