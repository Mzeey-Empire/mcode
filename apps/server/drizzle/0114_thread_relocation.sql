ALTER TABLE `messages` ADD `thread_move` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `relocation_workspace_id` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `relocation_fresh_session` integer;--> statement-breakpoint
ALTER TABLE `threads` ADD `relocation_note_generation` integer;--> statement-breakpoint
ALTER TABLE `threads` ADD `relocation_note_pending` integer;--> statement-breakpoint
ALTER TABLE `threads` ADD `relocation_turn` text;