import * as NodeCrypto from "node:crypto";
import { AgentEventType } from "@mcode/contracts/events/agent-event";
import type { AgentEvent } from "@mcode/contracts/events/agent-event";

/** Normalized todo shape consumed by the thread task-list projections. */
export interface TodoWriteItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: string;
}

/** Coerce an arbitrary status field to a TodoWrite-compatible status. */
export function coerceTodoStatus(status: unknown): TodoWriteItem["status"] {
  if (status === "in_progress" || status === "inProgress" || status === "in-progress") return "in_progress";
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "pending";
}

/** Normalize untrusted ACP plan entries into a full TodoWrite snapshot. */
export function acpPlanEntriesToTodos(entries: unknown): TodoWriteItem[] {
  if (!Array.isArray(entries)) return [];

  const todos: TodoWriteItem[] = [];
  entries.forEach((entry: unknown, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
    const content = "content" in entry && typeof entry.content === "string" ? entry.content.trim() : "";
    const todo: TodoWriteItem = {
      id: String(index),
      content: content || `Step ${index + 1}`,
      status: coerceTodoStatus("status" in entry ? entry.status : undefined),
    };
    if ("priority" in entry && typeof entry.priority === "string") todo.priority = entry.priority;
    todos.push(todo);
  });
  return todos;
}

/** Build a paired TodoWrite ToolUse and ToolResult from a complete todo snapshot. */
export function buildTodoWriteEvents(todos: TodoWriteItem[], threadId: string): AgentEvent[] {
  const toolCallId = `todo-write-${NodeCrypto.randomUUID()}`;
  return [
    {
      type: AgentEventType.ToolUse,
      threadId,
      toolCallId,
      toolName: "TodoWrite",
      toolInput: { todos },
    },
    {
      type: AgentEventType.ToolResult,
      threadId,
      toolCallId,
      output: `Updated ${todos.length} todo(s)`,
      isError: false,
    },
  ];
}
