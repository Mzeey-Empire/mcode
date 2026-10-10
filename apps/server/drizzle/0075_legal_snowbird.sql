ALTER TABLE `threads` ADD `seen_through_sequence` integer;--> statement-breakpoint
ALTER TABLE `threads` ADD `seen_at` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `last_turn_outcome` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `last_turn_ended_at` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `last_turn_sequence` integer;--> statement-breakpoint
UPDATE threads SET seen_through_sequence = (
  SELECT MAX(sequence) FROM messages WHERE messages.thread_id = threads.id AND outcome IS NOT NULL
), seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
