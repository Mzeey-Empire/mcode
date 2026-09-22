DROP INDEX `idx_hook_executions_message_sort_order`;--> statement-breakpoint
CREATE INDEX `idx_hook_executions_message_sort_order_id` ON `hook_executions` (`message_id`,`sort_order`,`id`);--> statement-breakpoint
DROP INDEX `idx_thought_segments_message_sort_order`;--> statement-breakpoint
CREATE INDEX `idx_thought_segments_message_final_sort_order_id` ON `thought_segments` (`message_id`,`is_final_response`,`sort_order`,`id`);--> statement-breakpoint
CREATE INDEX `idx_thought_segments_final_message_sort_order_id` ON `thought_segments` (`message_id`,`sort_order`,`id`) WHERE "thought_segments"."is_final_response" <> 0;--> statement-breakpoint
DROP INDEX `idx_tool_call_records_message_sort_order`;--> statement-breakpoint
CREATE INDEX `idx_tool_call_records_message_sort_order_id` ON `tool_call_records` (`message_id`,`sort_order`,`id`);