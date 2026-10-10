/**
 * Provider tools whose only effect is rewriting the thread task list. They
 * feed the task projection and never render as narrative rows or count as steps.
 */
export const TASK_LIST_TOOL_NAMES = ["TodoWrite", "TaskCreate", "TaskUpdate", "update_plan"] as const;

/** One provider tool name that writes the thread task list. */
export type TaskListToolName = (typeof TASK_LIST_TOOL_NAMES)[number];

const taskListToolNames: ReadonlySet<string> = new Set(TASK_LIST_TOOL_NAMES);

/** Whether a provider tool call only writes the thread task list. */
export function isTaskListToolName(toolName: string): toolName is TaskListToolName {
  return taskListToolNames.has(toolName);
}
