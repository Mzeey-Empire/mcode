import { describe, it, expect } from "vitest";
import { AgentEventType } from "@mcode/contracts";
import {
  acpPlanEntriesToTodos,
  buildTodoWriteEvents,
  coerceTodoStatus,
  type TodoWriteItem,
} from "../acp-plan-todo-write.js";

describe("coerceTodoStatus", () => {
  it("returns the canonical status for known values", () => {
    expect(coerceTodoStatus("pending")).toBe("pending");
    expect(coerceTodoStatus("in_progress")).toBe("in_progress");
    expect(coerceTodoStatus("inProgress")).toBe("in_progress");
    expect(coerceTodoStatus("in-progress")).toBe("in_progress");
    expect(coerceTodoStatus("completed")).toBe("completed");
    expect(coerceTodoStatus("cancelled")).toBe("cancelled");
  });

  it("normalizes the American 'canceled' spelling to 'cancelled'", () => {
    expect(coerceTodoStatus("canceled")).toBe("cancelled");
  });

  it("falls back to 'pending' for unknown or non-string input", () => {
    expect(coerceTodoStatus(undefined)).toBe("pending");
    expect(coerceTodoStatus(null)).toBe("pending");
    expect(coerceTodoStatus(42)).toBe("pending");
    expect(coerceTodoStatus("done")).toBe("pending");
  });
});

describe("acpPlanEntriesToTodos", () => {
  it.each([undefined, null, 42, "entries", {}])("ignores non-array input: %s", (entries) => {
    expect(acpPlanEntriesToTodos(entries)).toEqual([]);
  });

  it("skips non-record entries and preserves source positions", () => {
    expect(acpPlanEntriesToTodos([null, "bad", 42, [], { content: "  valid  ", priority: "medium" }])).toEqual([
      { id: "4", content: "valid", status: "pending", priority: "medium" },
    ]);
    expect(acpPlanEntriesToTodos([])).toEqual([]);
  });

  it("falls back for blank or non-string content and omits non-string priorities", () => {
    expect(acpPlanEntriesToTodos([
      { content: " \t ", priority: 3 },
      { content: 42, priority: null },
      {},
      { content: "keep", priority: "" },
    ])).toEqual([
      { id: "0", content: "Step 1", status: "pending" },
      { id: "1", content: "Step 2", status: "pending" },
      { id: "2", content: "Step 3", status: "pending" },
      { id: "3", content: "keep", status: "pending", priority: "" },
    ]);
  });

  it("coerces statuses without using provider entry ids", () => {
    expect(acpPlanEntriesToTodos([
      { id: "native", content: "first", status: "inProgress" },
      { content: "second", status: "in-progress" },
      { content: "third", status: "canceled" },
      { content: "fourth", status: "completed" },
      { content: "fifth", status: "unknown" },
    ])).toEqual([
      { id: "0", content: "first", status: "in_progress" },
      { id: "1", content: "second", status: "in_progress" },
      { id: "2", content: "third", status: "cancelled" },
      { id: "3", content: "fourth", status: "completed" },
      { id: "4", content: "fifth", status: "pending" },
    ]);
  });
});

describe("buildTodoWriteEvents", () => {
  it("emits a paired ToolUse + ToolResult with the exact todo list", () => {
    const todos: TodoWriteItem[] = [
      { id: "1", content: "first", status: "pending" },
      { id: "2", content: "second", status: "completed" },
    ];
    const events = buildTodoWriteEvents(todos, "thread-abc");
    expect(events).toHaveLength(2);

    const [use, result] = events;
    expect(use.type).toBe(AgentEventType.ToolUse);
    if (use.type !== AgentEventType.ToolUse) throw new Error("unreachable");
    expect(use.threadId).toBe("thread-abc");
    expect(use.toolName).toBe("TodoWrite");
    expect(use.toolInput).toEqual({ todos: [
      { id: "1", content: "first", status: "pending" },
      { id: "2", content: "second", status: "completed" },
    ] });

    expect(result.type).toBe(AgentEventType.ToolResult);
    if (result.type !== AgentEventType.ToolResult) throw new Error("unreachable");
    expect(result.threadId).toBe("thread-abc");
    expect(result.toolCallId).toBe(use.toolCallId);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("Updated 2 todo(s)");
  });

  it("uses a deterministic prefix for the toolCallId so it can be correlated in logs", () => {
    const events = buildTodoWriteEvents([{ id: "1", content: "x", status: "pending" }], "t");
    if (events[0].type !== AgentEventType.ToolUse) throw new Error("unreachable");
    expect(events[0].toolCallId.startsWith("todo-write-")).toBe(true);
  });
});
