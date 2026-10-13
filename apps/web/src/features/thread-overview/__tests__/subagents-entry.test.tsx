import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRosterEntry } from "@mcode/contracts";
import { mockTransport, createMockThread } from "@/__tests__/mocks/transport";
import { useSubagentRosterStore } from "@/features/subagents/state/subagentRosterStore";
import { SubagentsEntryBlock } from "../entries/subagents";

vi.mock("@/transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/transport")>(),
  getTransport: () => mockTransport,
}));

const thread = createMockThread({ id: "parent", provider: "codex" });

function entry(id: string, provider: SubagentRosterEntry["provider"], status: SubagentRosterEntry["status"]): SubagentRosterEntry {
  return { id: `call:${id}`, provider, title: id, prompt: null, subagentType: null, model: null, reasoningEffort: null, stepCount: 0,
    status, startedAt: "2026-10-10T10:00:00.000Z", endedAt: null, tier: "steps", canStop: false,
    sourceToolCallId: id, sourceMessageId: "message", childThreadId: null, parentEntryId: null };
}

function seed(entries: SubagentRosterEntry[]): void {
  useSubagentRosterStore.setState({ rosters: new Map([[thread.id, {
    owningParentThreadId: thread.id, epoch: "boot", revision: 1, entries, truncated: false,
  }]]), errors: new Set() });
}

describe("overview Subagents row", () => {
  beforeEach(() => seed([]));

  it("caps the disc stack at three and carries the totals in text", () => {
    seed([
      entry("a", "claude", "running"), entry("b", "codex", "done"), entry("c", "cursor", "running"),
      entry("d", "claude", "failed"), entry("e", "codex", "stopped"),
    ]);
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    const row = screen.getByTestId("thread-overview-subagents");
    expect(row.querySelectorAll('[data-testid="provider-disc"]')).toHaveLength(3);
    expect([...row.querySelectorAll("[data-provider-icon]")].map((icon) => icon.getAttribute("data-provider-icon")))
      .toEqual(["claude", "codex", "cursor"]);
    expect(row).toHaveTextContent("2 active · 3 done");
    expect(row).toHaveAccessibleName("Subagents, 2 active, 3 done");
  });

  it("shows only the done count when nothing is active", () => {
    seed([entry("a", "claude", "done")]);
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.getByTestId("thread-overview-subagents").textContent).toBe("1 done");
  });

  it("is absent when the roster is empty", () => {
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.queryByTestId("thread-overview-subagents")).not.toBeInTheDocument();
  });
});
