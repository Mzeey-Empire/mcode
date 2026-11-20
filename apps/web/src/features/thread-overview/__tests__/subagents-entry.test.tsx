import { createMockThread } from "@mcode/contracts/testing";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { mockTransport } from "@/__tests__/mocks/transport";
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
  useSubagentRosterStore.setState({ loads: new Map([[thread.id, { kind: "ready", roster: {
    owningParentThreadId: thread.id, epoch: "boot", revision: 1, entries, truncated: false,
  } }]]) });
}

describe("overview Subagents row", () => {
  beforeEach(() => seed([]));

  it("caps the disc stack at three and carries the totals in text", () => {
    seed([
      entry("a", "claude", "running"), entry("b", "codex", "finished"), entry("c", "cursor", "running"),
      entry("d", "claude", "failed"), entry("e", "codex", "stopped"),
    ]);
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    const row = screen.getByTestId("thread-overview-subagents");
    expect(row.querySelectorAll('[data-testid="provider-disc"]')).toHaveLength(3);
    expect([...row.querySelectorAll("[data-provider-icon]")].map((icon) => icon.getAttribute("data-provider-icon")))
      .toEqual(["claude", "codex", "cursor"]);
    expect(row).toHaveTextContent("2 running · 1 failed · 2 finished");
    expect(row).toHaveAccessibleName("Subagents, 2 running · 1 failed · 2 finished");
  });

  it("labels the row and shows only the finished count when nothing is live", () => {
    seed([entry("a", "claude", "finished")]);
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.getByTestId("thread-overview-subagents").textContent).toBe("Subagents1 finished");
  });

  it("omits the finished count when nothing has finished", () => {
    seed([entry("a", "claude", "running"), entry("b", "codex", "running")]);
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.getByTestId("thread-overview-subagents").textContent).toBe("Subagents2 running");
  });

  it("puts the user's subagents first in singular and plural", () => {
    seed([entry("a", "claude", "needs-you")]);
    const { unmount } = render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.getByTestId("thread-overview-subagents").textContent).toBe("Subagents1 needs you");
    unmount();
    seed([entry("a", "claude", "needs-you"), entry("b", "codex", "needs-you"), entry("c", "cursor", "setting-up")]);
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.getByTestId("thread-overview-subagents").textContent).toBe("Subagents2 need you · 1 running");
  });

  it("stays openable with Could not load after a failed first load", async () => {
    useSubagentRosterStore.setState({ loads: new Map() });
    vi.mocked(mockTransport.loadSubagentRoster).mockRejectedValueOnce(new Error("Disconnected"));
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    const row = await screen.findByTestId("thread-overview-subagents");
    expect(row.textContent).toBe("SubagentsCould not load");
    expect(row).toHaveAccessibleName("Subagents, Could not load");
  });

  it("marks the last good counts as out of date after a failed refresh", () => {
    const entries = [entry("a", "claude", "running")];
    useSubagentRosterStore.setState({ loads: new Map([[thread.id, { kind: "stale", roster: {
      owningParentThreadId: thread.id, epoch: "boot", revision: 1, entries, truncated: false,
    } }]]) });
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.getByTestId("thread-overview-subagents").textContent).toBe("Subagents1 running · may be out of date");
  });

  it("is absent when the roster is empty", () => {
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.queryByTestId("thread-overview-subagents")).not.toBeInTheDocument();
  });

  it("shows an out-of-date empty roster after a failed refresh", () => {
    useSubagentRosterStore.setState({ loads: new Map([[thread.id, { kind: "stale", roster: {
      owningParentThreadId: thread.id, epoch: "boot", revision: 1, entries: [], truncated: false,
    } }]]) });
    render(<SubagentsEntryBlock subject={{ kind: "thread", thread }} />);
    expect(screen.getByTestId("thread-overview-subagents")).toHaveAccessibleName("Subagents, May be out of date");
  });
});
