import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/transport/types";
import type { NarrativeItem } from "../../narrative/types";
import { TranscriptNarrativeRow } from "../TranscriptNarrativeRow";
import {
  expandTranscriptToolGroups,
  isTranscriptGroupOpen,
  toolCallDisclosureKey,
  type TranscriptNarrativeItem,
  type TranscriptToolItem,
} from "../transcript-narrative-items";
import { useTranscriptGroupExpansion } from "../useTranscriptGroupExpansion";

function shellCall(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    toolName: "Bash",
    toolInput: { command: `echo ${id}` },
    output: null,
    isError: false,
    isComplete: false,
    ...overrides,
  };
}

function narrativeRow(item: NarrativeItem, firstCallId: string): TranscriptNarrativeItem {
  return { type: "narrative-row", key: `narrative:live:tool:${firstCallId}:0`, item, index: 0 };
}

function toolGroupRow(calls: readonly ToolCall[]): TranscriptNarrativeItem {
  return narrativeRow({ type: "tool-group", group: { calls: [...calls] }, hasError: false, hasCancelled: false }, calls[0]!.id);
}

function activeRow(toolCall: ToolCall): TranscriptNarrativeItem {
  return narrativeRow({ type: "active-tool", toolCall }, toolCall.id);
}

function isTranscriptRow(row: { type: string }): row is TranscriptNarrativeItem | TranscriptToolItem {
  return row.type === "narrative-row" || row.type === "tool-row";
}

/** Mirrors MessageList: one transcript-owned key set, with rows remounting as the items change. */
function Transcript({ items }: { items: readonly TranscriptNarrativeItem[] }) {
  const { expanded, present, toggle } = useTranscriptGroupExpansion(() => new Set());
  const rows = expandTranscriptToolGroups(items, present).filter(isTranscriptRow);
  return (
    <>
      {rows.map((row) => {
        const callKey = toolCallDisclosureKey(row);
        return (
          <TranscriptNarrativeRow
            key={`${row.type}:${row.key}`}
            row={row}
            threadId={null}
            expanded={isTranscriptGroupOpen(row, expanded)}
            callExpanded={callKey !== undefined && expanded.has(callKey)}
            onToggle={toggle}
          />
        );
      })}
    </>
  );
}

describe("TranscriptNarrativeRow call disclosure", () => {
  it("keeps a running shell's manual open after its output arrives and it completes", () => {
    const view = render(<Transcript items={[activeRow(shellCall("tc-1"))]} />);
    fireEvent.click(screen.getByRole("button", { name: /Running command/ }));

    view.rerender(<Transcript items={[toolGroupRow([shellCall("tc-1", { isComplete: true, output: "first output" })])]} />);

    expect(screen.getByRole("button", { name: /Ran command/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("first output")).toBeVisible();
  });

  it("keeps an open lone shell listed and open when its group grows", () => {
    const first = shellCall("tc-1", { isComplete: true, output: "first output" });
    const view = render(<Transcript items={[toolGroupRow([first])]} />);
    fireEvent.click(screen.getByRole("button", { name: /Ran command/ }));

    view.rerender(<Transcript items={[toolGroupRow([first, shellCall("tc-2", { isComplete: true, output: "second output" })])]} />);

    const firstChild = screen.getByRole("list", { name: "Tool call 1 of 2" });
    expect(within(firstChild).getByRole("button", { name: /Ran command/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(firstChild).getByText("first output")).toBeVisible();
    expect(screen.queryByText("second output")).toBeNull();
  });

  it("opens the earlier group an open running shell completes into, and collapsing it closes the shell", () => {
    const read: ToolCall = { id: "read-1", toolName: "Read", toolInput: { file_path: "a.ts" }, output: "contents", isError: false, isComplete: true };
    const view = render(<Transcript items={[toolGroupRow([read]), activeRow(shellCall("tc-1"))]} />);
    fireEvent.click(screen.getByRole("button", { name: /Running command/ }));

    view.rerender(<Transcript items={[toolGroupRow([read, shellCall("tc-1", { isComplete: true, output: "first output" })])]} />);

    const shellChild = screen.getByRole("list", { name: "Tool call 2 of 2" });
    expect(within(shellChild).getByRole("button", { name: /Ran command/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(shellChild).getByText("first output")).toBeVisible();

    const summary = screen.getByRole("button", { name: /Read 1 file/ });
    expect(summary).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: /Read 1 file/ })).toHaveAttribute("aria-expanded", "false");
  });
});
