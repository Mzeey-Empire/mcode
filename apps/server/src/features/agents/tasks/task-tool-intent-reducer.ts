import type { BufferedToolCall } from "../conversation/narrative/narrative-turn-state.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import type { StoredTask } from "../orchestration/persistence/task-repo.js";

/** Narrative fields needed to resolve TaskCreate and sub-agent groups. */
export type TaskToolCall = Pick<BufferedToolCall, "toolCallId" | "toolName" | "parentToolCallId" | "_rawToolInput">;
type TaskPatch = Partial<Pick<StoredTask, "status" | "content" | "activeForm">>;

/** Data-only task writes for the execution's sole durable writer. */
export type TaskToolWriteIntent =
  | { readonly kind: "upsert-group"; readonly group: string; readonly tasks: StoredTask[] }
  | { readonly kind: "append-task"; readonly task: StoredTask }
  | { readonly kind: "update-task"; readonly id: string; readonly group: string; readonly patch: TaskPatch }
  | { readonly kind: "remove-task"; readonly id: string; readonly group: string };

/** Narrative attribution is resolved before a tool event reaches this reducer. */
export type TaskToolCommand =
  | {
    readonly kind: "tool-use";
    readonly toolName: string;
    readonly toolInput: Record<string, unknown>;
    readonly parentToolCallId?: string;
    readonly bufferedCalls: readonly TaskToolCall[];
  }
  | {
    readonly kind: "tool-result";
    readonly toolCallId: string;
    readonly output: string;
    readonly isError: boolean;
    readonly bufferedCalls: readonly TaskToolCall[];
  };

/** The writer receives intents only when the complete execution identity matches. */
export type TaskToolReduction =
  | { readonly kind: "intents"; readonly execution: ExecutionIdentity; readonly intents: TaskToolWriteIntent[] }
  | { readonly kind: "stale-execution" };

/** Pure task-tool interpretation shared by the live adapter and execution owner. */
export function taskToolWriteIntents(command: TaskToolCommand): TaskToolWriteIntent[] {
  if (command.kind === "tool-result") return taskCreateIntent(command);
  const { toolName, toolInput, parentToolCallId, bufferedCalls } = command;
  if (toolName !== "TodoWrite" && toolName !== "TaskUpdate" && toolName !== "update_plan") return [];
  const group = parentToolCallId ? groupFor(bufferedCalls, parentToolCallId) : "Tasks";
  if (toolName === "TodoWrite") return todoWriteIntents(toolInput, group);
  if (toolName === "TaskUpdate") return taskUpdateIntents(toolInput, group);
  return planIntents(toolInput, group);
}

/** Fences commands to one turn attempt before returning cloneable writer data. */
export class TaskToolIntentReducer {
  readonly execution: ExecutionIdentity;

  constructor(execution: ExecutionIdentity) {
    this.execution = { ...execution };
  }

  reduce(execution: ExecutionIdentity, command: TaskToolCommand): TaskToolReduction {
    if (execution.threadId !== this.execution.threadId
      || execution.turnId !== this.execution.turnId
      || execution.executionId !== this.execution.executionId) {
      return { kind: "stale-execution" };
    }
    return { kind: "intents", execution: { ...this.execution }, intents: taskToolWriteIntents(command) };
  }
}

function todoWriteIntents(input: Record<string, unknown>, group: string): TaskToolWriteIntent[] {
  if (!Array.isArray(input.todos)) return [];
  const tasks = input.todos.flatMap((value): StoredTask[] => {
    if (!isRecord(value) || !nonEmpty(value.content)) return [];
    return [{ content: String(value.content), status: status(value.status), group }];
  });
  return tasks.length > 0 ? [{ kind: "upsert-group", group, tasks }] : [];
}

function planIntents(input: Record<string, unknown>, group: string): TaskToolWriteIntent[] {
  const values = Array.isArray(input.plan)
    ? input.plan
    : Array.isArray(input.tasks)
      ? input.tasks
      : Array.isArray(input.todos)
        ? input.todos
        : [];
  const tasks = values.flatMap((value): StoredTask[] => {
    const item: Record<string, unknown> = isRecord(value) ? value : { step: value };
    const content = nonEmpty(item.step) ?? nonEmpty(item.content)
      ?? nonEmpty(item.title) ?? nonEmpty(item.description);
    return content ? [{ content, status: status(item.status), group }] : [];
  });
  return tasks.length > 0 ? [{ kind: "upsert-group", group, tasks }] : [];
}

function taskUpdateIntents(input: Record<string, unknown>, group: string): TaskToolWriteIntent[] {
  const id = input.taskId == null ? "" : String(input.taskId);
  if (!id) return [];
  if (input.status === "deleted") return [{ kind: "remove-task", id, group }];
  const patch: TaskPatch = {};
  if (input.status !== undefined) patch.status = status(input.status);
  const content = nonEmpty(input.subject);
  const activeForm = nonEmpty(input.activeForm);
  if (content) patch.content = content;
  if (activeForm) patch.activeForm = activeForm;
  return Object.keys(patch).length > 0 ? [{ kind: "update-task", id, group, patch }] : [];
}

function taskCreateIntent(command: Extract<TaskToolCommand, { kind: "tool-result" }>): TaskToolWriteIntent[] {
  if (command.isError) return [];
  const buffered = command.bufferedCalls
    .find((tool) => tool.toolCallId === command.toolCallId && tool.toolName === "TaskCreate");
  if (!buffered) return [];
  const id = /#(\d+)/.exec(command.output)?.[1];
  const input = buffered._rawToolInput ?? {};
  const content = taskContent(input);
  if (!id || !content) return [];
  const group = buffered.parentToolCallId ? groupFor(command.bufferedCalls, buffered.parentToolCallId) : "Tasks";
  const activeForm = nonEmpty(input.activeForm);
  return [{
    kind: "append-task",
    task: { id, content, status: "pending", ...(activeForm ? { activeForm } : {}), group },
  }];
}

function groupFor(calls: readonly TaskToolCall[], parentToolCallId: string): string {
  let current: string | undefined = parentToolCallId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const call = calls.find((item) => item.toolCallId === current);
    if (!call) break;
    if (call.toolName === "Agent") {
      const label = nonEmpty(call._rawToolInput?.description) ?? nonEmpty(call._rawToolInput?.prompt);
      return label ? label.slice(0, 80) : "Sub-agent";
    }
    current = call.parentToolCallId;
  }
  return "Sub-agent";
}

function status(value: unknown): StoredTask["status"] {
  switch (value) {
    case "inProgress":
    case "in-progress": return "in_progress";
    case "canceled": return "cancelled";
    case "pending":
    case "in_progress":
    case "completed":
    case "cancelled": return value;
    default: return "pending";
  }
}

function taskContent(input: Record<string, unknown>): string | null {
  const subject = nonEmpty(input.subject) ?? nonEmpty(input.title) ?? nonEmpty(input.content);
  const description = nonEmpty(input.description);
  if (!subject) return description;
  return description ? `${subject} - ${description}` : subject;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
