import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ApprovalReceiptRecord } from "@mcode/contracts/models/approval-receipt";
import type { ToolCall, ToolCallRecord } from "@/transport/types";
import { ApprovalReceiptRow, approvalReceiptCopy } from "../ApprovalReceiptRow";
import { buildNarrativeItems } from "../build-narrative";
import { buildPersistedNarrativeItems } from "../build-persisted-narrative";
import type { NarrativeItem } from "../types";

const BASE = Date.parse("2026-05-15T10:00:00Z");

function toolRecord(id: string, sortOrder: number, startedAt: number): ToolCallRecord {
  return {
    id,
    message_id: "m-1",
    parent_tool_call_id: null,
    tool_name: "Bash",
    input_summary: id,
    output_summary: "",
    status: "completed",
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date(startedAt + 500).toISOString(),
    sort_order: sortOrder,
  };
}

function liveTool(id: string, startedAt: number): ToolCall {
  return { id, toolName: "Bash", toolInput: { command: id }, output: "", isError: false, isComplete: true, startedAt };
}

function receiptRecord(sortOrder: number, decidedAt: number): ApprovalReceiptRecord {
  return {
    id: "req-1",
    message_id: "m-1",
    tool_call_id: null,
    kind: "command",
    subject_label: "bun run test",
    outcome: { status: "allowed", intent: "allow_once", choiceLabel: "Allow once" },
    origin: null,
    decided_at: new Date(decidedAt).toISOString(),
    sort_order: sortOrder,
  };
}

function shape(items: readonly NarrativeItem[]): string[] {
  return items.map((item) => (item.type === "approval" ? `approval:${item.receipt.requestId}` : item.type));
}

describe("approvalReceiptCopy", () => {
  it.each([
    [{ status: "allowed", intent: "allow_once", choiceLabel: "Allow once" }, "Allowed once", true],
    [{ status: "allowed", intent: "allow_scoped", choiceLabel: "Allow for this session" }, "Allowed for this session", true],
    [{ status: "allowed", intent: "allow_scoped", choiceLabel: "Always allow" }, "Always allowed", true],
    [{ status: "denied", choiceLabel: "Deny" }, "Denied", true],
    [{ status: "denied", choiceLabel: "Reject always" }, "Reject always", true],
    [{ status: "allowed", intent: "provider", choiceLabel: "Switch to Bypass" }, "Switch to Bypass", true],
    [{ status: "answered", count: 1 }, "Answered 1 question", false],
    [{ status: "answered", count: 3 }, "Answered 3 questions", false],
    [{ status: "cancelled", reason: "turn_ended" }, "Cancelled · turn ended", true],
    [{ status: "cancelled", reason: "session_stopped" }, "Cancelled · session stopped", true],
    [{ status: "cancelled", reason: "unanswerable" }, "Stopped · Mcode couldn't answer this request", false],
    [{ status: "auto_denied", reason: "too_large" }, "Denied automatically · too large to show", false],
    [{ status: "auto_denied", reason: "unreadable" }, "Denied automatically · Mcode couldn't read this request", false],
  ] as const)("renders %o as %s", (outcome, label, showsSubject) => {
    expect(approvalReceiptCopy(outcome)).toEqual({ label, showsSubject });
  });

  it("hides the subject when Mcode could not read the request", () => {
    render(
      <ApprovalReceiptRow
        receipt={{ requestId: "r", subjectLabel: "secret-ish", outcome: { status: "auto_denied", reason: "unreadable" }, decidedAt: 0 }}
      />,
    );
    expect(screen.getByText("Denied automatically · Mcode couldn't read this request")).toBeTruthy();
    expect(screen.queryByText("secret-ish")).toBeNull();
  });

  it("shows the note the user denied with", () => {
    render(
      <ApprovalReceiptRow
        receipt={{ requestId: "r", subjectLabel: "bun run lint", outcome: { status: "denied", choiceLabel: "Deny", note: "Run the tests instead" }, decidedAt: 0 }}
      />,
    );
    expect(screen.getByText("Denied")).toBeTruthy();
    expect(screen.getByText("Run the tests instead")).toBeTruthy();
  });
});

describe("tool approval subject", () => {
  it.each(["mcp__mcode__delegate_task", "mcp:mcode/delegate_task"])("names %s the way its tool row does after reload", (toolName) => {
    const [item] = buildPersistedNarrativeItems({
      tools: [],
      thoughts: [],
      hooks: [],
      approvals: [{ ...receiptRecord(0, BASE), kind: "tool", subject_label: toolName }],
    });
    if (item?.type !== "approval") throw new Error("expected an approval item");
    render(<ApprovalReceiptRow receipt={item.receipt} />);
    expect(screen.getByText("Delegate task")).toBeTruthy();
    expect(screen.queryByText(toolName)).toBeNull();
  });

  it("keeps a command subject verbatim", () => {
    const [item] = buildPersistedNarrativeItems({ tools: [], thoughts: [], hooks: [], approvals: [receiptRecord(0, BASE)] });
    if (item?.type !== "approval") throw new Error("expected an approval item");
    expect(item.receipt.subjectLabel).toBe("bun run test");
  });
});

describe("approval receipt position", () => {
  it("places the receipt between the same tool rows live and after reload", () => {
    const live = buildNarrativeItems({
      toolCalls: [liveTool("before", BASE), liveTool("after", BASE + 2_000)],
      hooks: [],
      approvals: [{ requestId: "req-1", subjectLabel: "bun run test", outcome: { status: "allowed", intent: "allow_once", choiceLabel: "Allow once" }, decidedAt: BASE + 1_000 }],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    }).items;
    const persisted = buildPersistedNarrativeItems({
      tools: [toolRecord("before", 0, BASE), toolRecord("after", 2, BASE + 2_000)],
      thoughts: [],
      hooks: [],
      approvals: [receiptRecord(1, BASE + 1_000)],
    });

    expect(shape(live)).toEqual(["tool-group", "approval:req-1", "tool-group"]);
    expect(shape(persisted)).toEqual(shape(live));
  });

  it("keeps a decision ahead of the tool it unblocked when both share a timestamp", () => {
    const live = buildNarrativeItems({
      toolCalls: [liveTool("unblocked", BASE)],
      hooks: [],
      approvals: [{ requestId: "req-1", subjectLabel: "bun run test", outcome: { status: "allowed", intent: "allow_once", choiceLabel: "Allow once" }, decidedAt: BASE }],
      thoughtSegments: [],
      streamingText: "",
      isAgentRunning: false,
    }).items;
    const persisted = buildPersistedNarrativeItems({
      tools: [toolRecord("unblocked", 1, BASE)],
      thoughts: [],
      hooks: [],
      approvals: [receiptRecord(0, BASE)],
    });

    expect(shape(live)).toEqual(["approval:req-1", "tool-group"]);
    expect(shape(persisted)).toEqual(shape(live));
  });
});
