CREATE TABLE `turn_retry_schedules` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`run_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
