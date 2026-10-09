import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookExecutionRecord, ToolCallRecord } from "@/transport/types";

const recordsByThread = vi.hoisted(() => new Map<string, { narrativeByMessage: Record<string, { tools: ToolCallRecord[]; thoughts: []; hooks: HookExecutionRecord[] }> }>());

vi.mock("@/stores/thread-selectors", () => ({
  useThreadRecord: (threadId: string | null | undefined, selector: (record: unknown) => unknown) => selector(
    recordsByThread.get(threadId ?? "") ?? { narrativeByMessage: {} },
  ),
}));

vi.mock("../NarrativeRows", () => ({
  NarrativeRows: ({
    items,
    onSubagentSelect,
  }: {
    items: readonly { type: string; toolCall?: { id: string } }[];
    onSubagentSelect?: (id: string, target: "active" | "finished") => void;
  }) => (
    <>
      <div data-testid="persisted-row-ids">
        {items
          .filter((item) => item.type === "subagent")
          .map((item) => item.toolCall?.id)
          .join(",")}
      </div>
      <button type="button" onClick={() => onSubagentSelect?.("child-tool", "finished")}>Open child</button>
    </>
  ),
}));

import { PersistedNarrative } from "../PersistedNarrative";
import { PersistedTurnHooks } from "../PersistedTurnHooks";

function tool(id: string, toolName = "Read"): ToolCallRecord {
  return {
    id,
    message_id: "assistant-1",
    parent_tool_call_id: null,
    tool_name: toolName,
    input_summary: "",
    output_summary: "",
    status: "completed",
    started_at: "2026-08-18T10:00:00.000Z",
    completed_at: "2026-08-18T10:00:01.000Z",
    sort_order: 1,
  };
}

function stopHook(hookName: string): HookExecutionRecord {
  return {
    id: `${hookName}-id`,
    message_id: "assistant-1",
    hook_name: hookName,
    tool_name: null,
    phase: "stop",
    payload: "{}",
    duration_ms: 1,
    did_block: false,
    started_at: "2026-08-18T10:00:01.000Z",
    ended_at: "2026-08-18T10:00:01.001Z",
    sort_order: 2,
  };
}

describe("persisted child timeline thread selection", () => {
  it("adds late hooks to the response action without mixing threads", async () => {
    const user = userEvent.setup();
    recordsByThread.set("child-thread", { narrativeByMessage: { "assistant-1": { tools: [], thoughts: [], hooks: [] } } });
    const view = render(<PersistedTurnHooks threadId="child-thread" messageId="assistant-1" />);
    expect(screen.queryByRole("button", { name: "Hooks" })).not.toBeInTheDocument();
    recordsByThread.set("child-thread", { narrativeByMessage: { "assistant-1": { tools: [], thoughts: [], hooks: [stopHook("LateStop")] } } });
    view.rerender(<PersistedTurnHooks threadId="child-thread" messageId="assistant-1" />);
    await user.hover(screen.getByRole("button", { name: "Hooks" }));
    const dialog = await screen.findByRole("dialog", { name: "Hooks" });
    expect(dialog).toHaveTextContent("LateStop");
    expect(dialog).not.toHaveTextContent("ParentStop");
  });

  beforeEach(() => {
    recordsByThread.clear();
    recordsByThread.set("parent-thread", {
      narrativeByMessage: {
        "assistant-1": { tools: [tool("parent-tool"), tool("parent-agent", "Agent")], thoughts: [], hooks: [stopHook("ParentStop")] },
      },
    });
    recordsByThread.set("child-thread", {
      narrativeByMessage: {
        "assistant-1": { tools: [tool("child-tool", "Agent")], thoughts: [], hooks: [stopHook("ChildStop")] },
      },
    });
  });

  it("reads persisted narrative and hook records from the explicitly rendered child thread", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PersistedNarrative threadId="child-thread" messageId="assistant-1" messageContent="Child result" />
        <PersistedTurnHooks threadId="child-thread" messageId="assistant-1" />
      </>,
    );

    expect(screen.getByTestId("persisted-row-ids")).toHaveTextContent("child-tool");
    expect(screen.getByTestId("persisted-row-ids")).not.toHaveTextContent("parent-agent");
    await user.hover(screen.getByRole("button", { name: "Hooks" }));
    const dialog = await screen.findByRole("dialog", { name: "Hooks" });
    expect(dialog).toHaveTextContent("ChildStop");
    expect(dialog).not.toHaveTextContent("ParentStop");
  });

  it("routes persisted subagent rows through the chat detail callback", () => {
    const onSubagentSelect = vi.fn();

    render(
      <PersistedNarrative
        threadId="child-thread"
        messageId="assistant-1"
        messageContent="Child result"
        onSubagentSelect={onSubagentSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));

    expect(onSubagentSelect).toHaveBeenCalledWith("child-tool", "finished");
  });

  it("reconstructs the persisted child row when tools hydrate after the stored message", () => {
    recordsByThread.set("child-thread", {
      narrativeByMessage: {
        "assistant-1": {
          tools: [tool("command-tool", "command_execution")],
          thoughts: [],
          hooks: [],
        },
      },
    });

    const view = render(
      <PersistedNarrative threadId="child-thread" messageId="assistant-1" messageContent="Child result" />,
    );
    expect(screen.getByTestId("persisted-row-ids")).toHaveTextContent("");

    recordsByThread.set("child-thread", {
      narrativeByMessage: {
        "assistant-1": {
          tools: [
            tool("command-tool", "command_execution"),
            tool("child-agent", "Agent"),
          ],
          thoughts: [],
          hooks: [],
        },
      },
    });
    view.rerender(
      <PersistedNarrative threadId="child-thread" messageId="assistant-1" messageContent="Child result" />,
    );

    expect(screen.getByTestId("persisted-row-ids")).toHaveTextContent("child-agent");
  });
});
