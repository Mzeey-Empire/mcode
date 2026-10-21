/**
 * Regression tests for long shell-command layout in narrative tool rows.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { ActiveToolRow } from "../ActiveToolRow";
import { ToolSummaryLine } from "../ToolSummaryLine";
import { buildPersistedNarrativeItems } from "../build-persisted-narrative";
import { buildToolSummaryText, isShellTool, resolveToolName } from "@/components/chat/tool-renderers/constants";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import type { ToolGroup } from "../types";
import { SubagentProviderScope } from "../subagent-provider";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";

/** Long unbroken path + git add, matching real overflow reports. */
export const LONG_SHELL_COMMAND =
  'cd "C:\\Users\\cjnwo\\.mcode\\worktrees\\mcode\\feat-cursor-sub-agents-71ba0f21" && git add apps/web/src/features/conversation/narrative/SubagentRow.tsx';

const COLUMN_CLASS = "w-[480px] min-w-0 max-w-full overflow-hidden";

function makeBashCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "tc-bash-1",
    toolName: "Bash",
    toolInput: { command: LONG_SHELL_COMMAND },
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

describe("resolveToolName", () => {
  it("maps provider shell aliases to Bash", () => {
    expect(resolveToolName("Shell")).toBe("Bash");
    expect(resolveToolName("command_execution")).toBe("Bash");
    expect(resolveToolName("Read")).toBe("Read");
  });

  it("groups shell aliases in buildToolSummaryText", () => {
    const text = buildToolSummaryText([
      { toolName: "Bash" },
      { toolName: "command_execution" },
    ]);
    expect(text).toBe("Ran 2 commands");
  });

  it("treats shell aliases as shell tools for output blocks", () => {
    expect(isShellTool("Shell")).toBe(true);
    expect(isShellTool("Read")).toBe(false);
  });
});

describe("narrative tool row layout classes", () => {
  it("ActiveToolRow renders shell commands as expandable terminal cards", async () => {
    const { container } = render(
      <div className={COLUMN_CLASS}>
        <ActiveToolRow toolCall={makeBashCall()} />
      </div>,
    );

    const button = screen.getByRole("button", { name: /Running command/ });
    const commandPreview = within(button).getByText(LONG_SHELL_COMMAND);
    const user = userEvent.setup();

    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.hover(commandPreview);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent(LONG_SHELL_COMMAND);
    });

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    const command = container.querySelector("code");
    expect(command?.textContent).toBe(LONG_SHELL_COMMAND);
  });

  it("ActiveToolRow identifies an in-progress approval review without its native id", () => {
    render(
      <ActiveToolRow
        toolCall={makeBashCall({
          id: "approval-review-1",
          toolName: "Approval review",
          toolInput: { reviewId: "approval-review-1" },
        })}
      />,
    );

    expect(screen.getByText("Reviewing")).toBeVisible();
    expect(screen.queryByText("approval-review-1")).toBeNull();
  });

  it("ToolSummaryLine renders a lone shell call as its own row and reveals a shell transcript", async () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-1",
          isComplete: true,
          output: "command output",
          durationMs: 15_000,
        }),
      ],
    };

    const { container } = render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} />
      </div>,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    const child = screen.getByRole("button", { name: /Ran command/ });
    expect(child).toHaveAttribute("aria-expanded", "false");
    expect(within(child).getByText("0:15")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Shell output" })).toBeNull();
    const commandPreview = within(child).getByText(LONG_SHELL_COMMAND);
    expect(child.querySelector("[data-slot='tooltip-trigger']")).toBeNull();
    const user = userEvent.setup();
    await user.hover(commandPreview);
    await waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>("[data-slot='tooltip-content']");
      expect(tooltip).toBeVisible();
      expect(tooltip).toHaveTextContent(LONG_SHELL_COMMAND);
    });

    fireEvent.click(child);

    expect(screen.getByRole("region", { name: "Shell output" })).toBeTruthy();
    expect(screen.getByText("Shell")).toBeTruthy();
    expect(container.querySelector("code")?.textContent).toBe(LONG_SHELL_COMMAND);
    expect(screen.getByText("command output")).toBeTruthy();
  });

  it("keeps a lone shell transcript open across a virtual row remount", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({ id: "tc-1", isComplete: true, output: "command output" })],
    };
    let open = false;
    const virtualExpansion = { get open() { return open; }, onToggle: () => { open = !open; } };
    const first = render(<ToolSummaryLine group={group} virtualExpansion={virtualExpansion} />);
    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    first.unmount();

    render(<ToolSummaryLine group={group} virtualExpansion={virtualExpansion} />);

    expect(screen.getByRole("button", { name: /Ran command/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("command output")).toBeVisible();
  });

  it("ToolSummaryLine shows the persisted approval review outcome", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({
        id: "approval-review-1",
        toolName: "Approval review",
        toolInput: { reviewId: "approval-review-1" },
        output: "Approved",
        isComplete: true,
      })],
    };

    render(<ToolSummaryLine group={group} />);

    expect(screen.getByText("Reviewed")).toBeVisible();
    expect(screen.getByText("Approved")).toBeVisible();
    expect(screen.queryByText("approval-review-1")).toBeNull();
  });

  it("ToolSummaryLine identifies an active approval review without exposing its native id", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({
        id: "approval-review-1",
        toolName: "Approval review",
        toolInput: { reviewId: "approval-review-1" },
      })],
    };

    render(<ToolSummaryLine group={group} />);

    expect(screen.getByText("Reviewing")).toBeVisible();
    expect(screen.queryByText("approval-review-1")).toBeNull();
  });

  it("ToolSummaryLine renders duration hydrated from a persisted shell call", () => {
    const persisted: ToolCallRecord = {
      id: "tc-persisted",
      message_id: "message-1",
      parent_tool_call_id: null,
      tool_name: "Shell",
      input_summary: JSON.stringify({ command: LONG_SHELL_COMMAND }),
      output_summary: "command output",
      status: "completed",
      started_at: "2026-05-15T10:00:00Z",
      completed_at: "2026-05-15T10:00:15Z",
      sort_order: 1,
    };
    const items = buildPersistedNarrativeItems({
      tools: [persisted],
      thoughts: [],
      hooks: [],
    });

    expect(items[0].type).toBe("tool-group");
    if (items[0].type !== "tool-group") return;

    render(
      <ToolSummaryLine group={items[0].group} />,
    );

    expect(screen.getByRole("button", { name: /Ran command/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("0:15")).toBeTruthy();
  });

  it("ToolSummaryLine maps command_execution to terminal icon via Bash alias", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-codex",
          toolName: "command_execution",
          isComplete: true,
        }),
      ],
    };

    const { container } = render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    expect(container.querySelector(".lucide-terminal")).toBeTruthy();
    expect(screen.getByText("Ran command")).toBeTruthy();
  });

  it("ToolSummaryLine marks a cancelled command as cancelled", () => {
    render(<ToolSummaryLine group={{ calls: [makeBashCall({ isComplete: true, isCancelled: true })] }} />);

    const row = screen.getByRole("button", { name: /Ran command/ });
    expect(within(row).getByText("cancelled")).toBeInTheDocument();
  });

  it("does not round a sub-second shell duration up to one second", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({ isComplete: true, durationMs: 500 })],
    };

    render(<ToolSummaryLine group={group} />);

    expect(screen.getByRole("button", { name: /Ran command/ })).not.toHaveTextContent(/0:0[01]/);
  });

  it("shows cancelled for a persisted cancelled shell call", () => {
    const group: ToolGroup = {
      calls: [makeBashCall({ isComplete: true, isCancelled: true })],
    };

    render(<ToolSummaryLine group={group} />);

    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    expect(screen.getAllByText("cancelled")).toHaveLength(2);
  });

  it("normalizes older persisted Codex command summaries before display", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-persisted",
          toolName: "command_execution",
          toolInput: { _summary: JSON.stringify({ command: LONG_SHELL_COMMAND }) },
          isComplete: true,
        }),
      ],
    };

    const { container } = render(
      <ToolSummaryLine group={group} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    expect(container.querySelector("code")?.textContent).toBe(LONG_SHELL_COMMAND);
    expect(container.textContent).not.toContain('{"command"');
  });

  it("normalizes truncated legacy Codex summaries without escaped path syntax", () => {
    const legacySummary = JSON.stringify({ command: LONG_SHELL_COMMAND }).slice(0, 80);
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-truncated-summary",
          toolName: "command_execution",
          toolInput: { _summary: legacySummary },
          isComplete: true,
        }),
      ],
    };

    const { container } = render(
      <ToolSummaryLine group={group} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));
    const command = container.querySelector("code")?.textContent ?? "";
    expect(command).toMatch(/^cd "C:\\Users\\cjnwo/);
    expect(command).not.toContain("\\\\Users");
    expect(command).not.toContain('{"command"');
  });

  it("ToolSummaryLine shows truncation metadata for bounded output", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-truncated",
          output: "preview",
          isComplete: true,
          outputTruncated: true,
          outputTotalBytes: 300 * 1024,
          outputArtifactPath: "C:\\mcode\\artifacts\\tool-output\\thread\\tool.txt",
        }),
      ],
    };

    render(
      <div className={COLUMN_CLASS}>
        <ToolSummaryLine group={group} />
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));

    const notice = screen.getByText(/Output truncated/);
    expect(notice.textContent).toContain("300 KB total");
    expect(notice.textContent).toContain("full output saved");
  });

  it("shows a shell exit code status badge inside the expanded panel", () => {
    const group: ToolGroup = {
      calls: [
        makeBashCall({
          id: "tc-failed",
          output: "fatal: remote failed",
          isComplete: true,
          isError: true,
          exitCode: 1,
        }),
      ],
    };

    render(
      <ToolSummaryLine group={group} />,
    );

    const child = screen.getByRole("button", { name: /Ran command/ });
    expect(child).toHaveTextContent(/exit 1$/);
    fireEvent.click(child);

    const panel = screen.getByRole("region", { name: "Shell output" });
    const exitCode = screen.getByText("exit code 1");
    expect(panel).toContainElement(exitCode);
    expect(exitCode).toHaveAttribute("role", "status");
  });

  it.each(["file_change", "apply_patch", "Edit"])("reads a lone failed %s as Edit failed with its file", (toolName) => {
    const { container } = render(
      <ToolSummaryLine
        group={{
          calls: [makeBashCall({
            toolName,
            toolInput: { file_path: "src/app/config.ts" },
            output: "patch did not apply",
            isComplete: true,
            isError: true,
          })],
        }}
      />,
    );

    const row = screen.getByRole("button", { name: /^Edit failed/ });
    expect(row).toHaveTextContent(/^Edit failedconfig\.ts$/);
    expect(container.querySelector(".lucide-pencil")).toBeTruthy();
    expect(screen.queryByText("patch did not apply")).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText("patch did not apply")).toBeInTheDocument();
  });

  it("names a single Codex file change by its file", () => {
    render(<ToolSummaryLine group={{ calls: [makeBashCall({ toolName: "file_change", toolInput: { files: "src\\lib\\time.ts" }, isComplete: true })] }} />);

    expect(screen.getByText("Edited file").parentElement).toHaveTextContent(/^Edited filetime\.ts$/);
  });

  it("names a persisted file change by the file in its stored summary", () => {
    render(<ToolSummaryLine group={{ calls: [makeBashCall({ toolName: "file_change", toolInput: { _summary: "F:\\dev\\fixture-repo\\README.md" }, isComplete: true })] }} />);

    expect(screen.getByText("Edited file").parentElement).toHaveTextContent(/^Edited fileREADME\.md$/);
  });

  it("does not read a path out of an older truncated JSON summary", () => {
    const path = "F:\\dev\\worktrees\\t3\\mcode\\t3-49c74bf1\\.dev\\fixture-repo\\README.md";
    const _summary = JSON.stringify({ files: path, changes: [{ path, kind: { type: "update" } }] }).slice(0, 200);
    render(<ToolSummaryLine group={{ calls: [makeBashCall({ toolName: "file_change", toolInput: { _summary }, isComplete: true })] }} />);

    expect(screen.getByText("Edited file").parentElement).toHaveTextContent(/^Edited file$/);
  });

  it("summarizes several calls with their failures and lists each on open", () => {
    render(
      <ToolSummaryLine
        group={{
          calls: [
            makeBashCall({ id: "read-1", toolName: "Read", toolInput: { file_path: "a.ts" }, isComplete: true }),
            makeBashCall({ id: "read-2", toolName: "Read", toolInput: { file_path: "b.ts" }, isComplete: true, isError: true }),
          ],
        }}
      />,
    );

    // jsdom drops the count's leading space from the name; Chromium keeps it.
    const summary = screen.getByRole("button", { name: /^Read 2 files ?· 1 failed$/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(summary);
    expect(screen.getByText("Read file")).toBeVisible();
    expect(screen.getByText("Read failed")).toBeVisible();
  });
});

const MCODE_MCP_SPELLINGS = ["mcp:mcode/", "mcp__mcode__"] as const;

function taskCall(toolName: string, id = "tc-task-1"): ToolCall {
  return { id, toolName, toolInput: { taskId: "task-123" }, output: null, isError: false, isComplete: true };
}

function seedTaskRoster(title: string): void {
  useSubagentRosterStore.setState({ rosters: new Map([["parent", {
    owningParentThreadId: "parent", epoch: "boot", revision: 1, truncated: false,
    entries: [{ id: "task:task-123", provider: "codex", title, prompt: null, subagentType: null, model: null,
      reasoningEffort: null, stepCount: 0, status: "running", startedAt: "2026-10-10T10:00:00.000Z",
      endedAt: null, tier: "transcript", canStop: true, sourceToolCallId: null, childThreadId: "child",
      sourceMessageId: null, parentEntryId: null }],
  }]]), errors: new Set() });
}

describe.each(MCODE_MCP_SPELLINGS)("Mcode MCP task tools named %s*", (prefix) => {
  it("resolves to the bare tool name", () => {
    expect(resolveToolName(`${prefix}task_status`)).toBe("task_status");
    expect(resolveToolName(`${prefix}delegate_task`)).toBe("delegate_task");
  });

  it("summarizes polls and cancels with task verbs", () => {
    expect(buildToolSummaryText([
      { toolName: `${prefix}task_status` },
      { toolName: `${prefix}task_status` },
      { toolName: `${prefix}task_cancel` },
    ])).toBe("Checked 2 tasks, Cancelled 1 task");
  });

  it("labels a task_status row with the task title instead of the raw id", () => {
    seedTaskRoster("Fix login redirect");
    render(<SubagentProviderScope threadId="parent">
      <ToolSummaryLine group={{ calls: [taskCall(`${prefix}task_status`)] }} />
    </SubagentProviderScope>);
    expect(screen.getByText("Check task")).toBeInTheDocument();
    expect(screen.getByText("Fix login redirect")).toBeInTheDocument();
    expect(screen.queryByText(/task-123/)).not.toBeInTheDocument();
  });

  it("labels a reloaded task_status row, whose input is the persisted JSON summary, with the task title", () => {
    seedTaskRoster("Fix login redirect");
    const persisted = { ...taskCall(`${prefix}task_status`), toolInput: { _summary: '{"taskId":"task-123"}' } };
    render(<SubagentProviderScope threadId="parent">
      <ToolSummaryLine group={{ calls: [persisted] }} />
    </SubagentProviderScope>);
    expect(screen.getByText("Fix login redirect")).toBeInTheDocument();
  });

  it("shows no raw task id when the roster has no title for it", () => {
    useSubagentRosterStore.setState({ rosters: new Map(), errors: new Set() });
    render(<ToolSummaryLine group={{ calls: [taskCall(`${prefix}task_cancel`)] }} />);
    expect(screen.getByText("Cancel task")).toBeInTheDocument();
    expect(screen.queryByText(/task-123|taskId/)).not.toBeInTheDocument();
  });

  it("leaves the label unclipped when the roster has no title for it", () => {
    useSubagentRosterStore.setState({ rosters: new Map(), errors: new Set() });
    render(<ToolSummaryLine group={{ calls: [taskCall(`${prefix}task_cancel`)] }} />);
    expect(screen.getByText("Cancel task")).not.toHaveClass("max-w-[60%]");
  });
});

const MCODE_THREAD_TOOLS = [
  "workspace_search", "worktree_list", "thread_target_list", "thread_search",
  "thread_get", "thread_send", "thread_stop", "thread_wait",
] as const;

function mcodeCall(toolName: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: "tc-mcode-1", toolName, toolInput: {}, output: null, isError: false, isComplete: true, ...overrides };
}

describe.each(MCODE_MCP_SPELLINGS)("Mcode MCP thread tools named %s*", (prefix) => {
  it.each(MCODE_THREAD_TOOLS)("labels a finished %s row in plain words", (tool) => {
    render(<ToolSummaryLine group={{ calls: [mcodeCall(`${prefix}${tool}`)] }} />);
    expect(screen.queryByText(new RegExp(tool))).not.toBeInTheDocument();
  });

  it.each(MCODE_THREAD_TOOLS)("labels a failed %s row in plain words", (tool) => {
    render(<ToolSummaryLine group={{ calls: [mcodeCall(`${prefix}${tool}`, { isError: true, output: "boom" })] }} />);
    expect(screen.queryByText(new RegExp(tool))).not.toBeInTheDocument();
  });

  it.each(MCODE_THREAD_TOOLS)("summarizes a group of %s calls in plain words", (tool) => {
    const call = mcodeCall(`${prefix}${tool}`);
    expect(buildToolSummaryText([call, call])).not.toContain(tool);
  });

  it("shows a running thread_target_list row without its raw name", () => {
    render(<ActiveToolRow toolCall={mcodeCall(`${prefix}thread_target_list`, { isComplete: false })} />);
    expect(screen.getByText("Listed targets")).toBeInTheDocument();
    expect(screen.queryByText(/thread_target_list/)).not.toBeInTheDocument();
  });

  it("shows no detail and an unclipped label for a reloaded row whose input was empty", () => {
    render(<ToolSummaryLine group={{ calls: [mcodeCall(`${prefix}thread_target_list`, { toolInput: { _summary: "{}" } })] }} />);
    expect(screen.queryByText("{}")).not.toBeInTheDocument();
    expect(screen.getByText("Listed targets")).not.toHaveClass("max-w-[60%]");
  });
});

describe("unknown tool summary", () => {
  it("counts calls instead of pluralizing the tool name", () => {
    expect(buildToolSummaryText([{ toolName: "mcp:other/lookup" }])).toBe("1 mcp:other/lookup call");
    expect(buildToolSummaryText([{ toolName: "lookup" }, { toolName: "lookup" }])).toBe("2 lookup calls");
  });
});
