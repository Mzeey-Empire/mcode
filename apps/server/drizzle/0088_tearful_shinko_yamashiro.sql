CREATE TABLE `__new_plan_question_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`assistant_message_id` text,
	`thread_id` text NOT NULL,
	`answered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`native_batch_json` text,
	`status` text DEFAULT 'answered' NOT NULL,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_plan_question_answers`("id", "assistant_message_id", "thread_id", "answered_at") SELECT "assistant_message_id", "assistant_message_id", "thread_id", "answered_at" FROM `plan_question_answers`;--> statement-breakpoint
DROP TABLE `plan_question_answers`;--> statement-breakpoint
ALTER TABLE `__new_plan_question_answers` RENAME TO `plan_question_answers`;--> statement-breakpoint
CREATE UNIQUE INDEX `plan_question_answers_assistant_message_id_unique` ON `plan_question_answers` (`assistant_message_id`);--> statement-breakpoint
CREATE INDEX `idx_plan_question_answers_thread_answered_at` ON `plan_question_answers` (`thread_id`,`answered_at`);
