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
    expect(commandPreview).toHaveClass("text-fade");
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
    expect(command?.className).toContain("whitespace-pre-wrap");
    expect(command?.className).toContain("overflow-wrap");
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

    const detail = within(child).getByText(LONG_SHELL_COMMAND);

    expect(detail.className).toContain("text-fade");
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

  it("ToolSummaryLine renders a cancelled command in mono meta text", () => {
    render(<ToolSummaryLine group={{ calls: [makeBashCall({ isComplete: true, isCancelled: true })] }} />);

    const row = screen.getByRole("button", { name: /Ran command/ });
    expect(within(row).getByText("cancelled")).toHaveClass("font-mono", "text-xs", "text-muted");
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
    expect(notice.className).toContain("text-xs");
  });

  it("shows a shell exit code status badge at the bottom right of the expanded panel", () => {
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
    expect(exitCode).toHaveClass("text-muted");
    expect(exitCode).toHaveAttribute("role", "status");
    expect(exitCode.closest("footer")).toHaveClass("justify-end");
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
    expect(screen.getByText("patch did not apply")).not.toHaveClass("text-[var(--diff-remove)]");
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

    expect(screen.getByText("Edited file").parentElement).toHaveTextContent(/^Edited filefile_change$/);
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

    const summary = screen.getByRole("button", { name: "Read 2 files · 1 failed" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(summary);
    expect(screen.getByText("Read file")).toBeVisible();
    expect(screen.getByText("Read failed")).toBeVisible();
  });
});
