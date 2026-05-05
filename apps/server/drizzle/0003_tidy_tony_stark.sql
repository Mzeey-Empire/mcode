ALTER TABLE `messages` ADD `reply_to_message_id` text REFERENCES messages(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `quoted_text` text;