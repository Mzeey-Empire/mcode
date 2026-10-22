ALTER TABLE `delegated_tasks` ADD `notice_delivered` text;--> statement-breakpoint
ALTER TABLE `delegated_tasks` ADD `notice_claim` text;--> statement-breakpoint
UPDATE delegated_tasks
SET notice_delivered = COALESCE(
  (SELECT 'finished:' || CASE t.status
      WHEN 'Completed' THEN 'completed' WHEN 'Errored' THEN 'failed'
      WHEN 'Cancelled' THEN 'cancelled' WHEN 'Interrupted' THEN 'interrupted' END || ':' || t.id
   FROM canonical_agent_turns t
   JOIN thread_startups s ON s.startup_id = delegated_tasks.task_id AND s.thread_id = t.thread_id
   WHERE t.id = delegated_tasks.task_id OR t.attempt_of = delegated_tasks.task_id
   ORDER BY t.rowid DESC LIMIT 1),
  'failed:startup:' || task_id)
WHERE COALESCE(
  (SELECT t.status FROM canonical_agent_turns t
   JOIN thread_startups s ON s.startup_id = delegated_tasks.task_id AND s.thread_id = t.thread_id
   WHERE t.id = delegated_tasks.task_id OR t.attempt_of = delegated_tasks.task_id
   ORDER BY t.rowid DESC LIMIT 1), '') IN ('Completed', 'Errored', 'Cancelled', 'Interrupted')
OR (NOT EXISTS (SELECT 1 FROM canonical_agent_turns t
    JOIN thread_startups s ON s.startup_id = delegated_tasks.task_id AND s.thread_id = t.thread_id
    WHERE t.id = delegated_tasks.task_id OR t.attempt_of = delegated_tasks.task_id)
  AND NOT EXISTS (SELECT 1 FROM thread_startups s WHERE s.startup_id = delegated_tasks.task_id
    AND s.state IN ('pending', 'running', 'blocked'))
  AND NOT EXISTS (SELECT 1 FROM thread_control_approvals a WHERE a.id = delegated_tasks.task_id AND a.status = 'pending'));
