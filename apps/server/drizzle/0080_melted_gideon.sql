CREATE TABLE `turn_steers` (
	`message_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_execution_id` text NOT NULL,
	`inputs_hash` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`rejection` text,
	`replacement_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "turn_steers_state" CHECK("turn_steers"."state" IN ('pending', 'delivered', 'rejected', 'delivery_unknown', 'resend_queued', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_steers_replacement_message_id_unique` ON `turn_steers` (`replacement_message_id`);--> statement-breakpoint
CREATE INDEX `idx_turn_steers_state` ON `turn_steers` (`state`);