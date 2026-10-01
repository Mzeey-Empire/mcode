CREATE TABLE `canonical_writer_thread_operation_receipts` (
	`execution_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`kind` text NOT NULL,
	`input_hash` text NOT NULL,
	`receipt_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`execution_id`, `operation_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `canonical_agent_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "canonical_writer_thread_receipts_append_only" CHECK("canonical_writer_thread_operation_receipts"."kind" = 'append-accepted')
);
--> statement-breakpoint
CREATE INDEX `idx_canonical_writer_thread_receipts_thread` ON `canonical_writer_thread_operation_receipts` (`thread_id`);
--> statement-breakpoint
-- Earlier accepted writes saved publication IDs without advancing their durable allocation head.
WITH publications AS (
  SELECT events.thread_id,
    CASE WHEN json_valid(events.envelope_json) THEN events.envelope_json ELSE '{}' END AS envelope
  FROM canonical_agent_events AS events
  INNER JOIN threads ON threads.id = events.thread_id
), publication_ids AS (
  SELECT thread_id,
    json_extract(envelope, '$.payload.publicationId') AS publication_id,
    json_type(envelope, '$.payload.publicationId') AS publication_id_type
  FROM publications
  WHERE json_extract(envelope, '$.payload.type') = 'publication.recorded'
), sequences AS (
  SELECT thread_id,
    CASE WHEN publication_id_type = 'text'
      AND publication_id GLOB '[1-9]*'
      AND publication_id NOT GLOB '*[^0-9]*'
      AND (length(publication_id) < 16
        OR (length(publication_id) = 16 AND publication_id <= '9007199254740991'))
      THEN CAST(publication_id AS INTEGER)
    END AS sequence
  FROM publication_ids
)
INSERT INTO canonical_writer_live_publication_heads (thread_id, last_sequence)
SELECT thread_id, MAX(sequence)
FROM sequences
GROUP BY thread_id
HAVING MAX(sequence) IS NOT NULL
ON CONFLICT(thread_id) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence);
