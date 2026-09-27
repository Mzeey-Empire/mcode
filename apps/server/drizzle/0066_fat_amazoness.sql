CREATE TABLE `canonical_writer_live_publication_heads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`last_sequence` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
