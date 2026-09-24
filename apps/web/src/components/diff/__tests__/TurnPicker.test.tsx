import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnSnapshot } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { TurnPicker } from "../TurnPicker";

class ObserverMock {
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {};
}

function snapshot(
  messageId: string,
  createdAt: string,
  fileCount: number,
): TurnSnapshot {
  return {
    id: `snap-${messageId}`,
    message_id: messageId,
    thread_id: "thread-1",
    ref_before: "a".repeat(40),
    ref_after: "b".repeat(40),
    files_changed: Array.from({ length: fileCount }, (_, i) => `f${i}.ts`),
    file_effects: {
      revision: 0,
      fileCount,
      additions: fileCount,
      deletions: 0,
      effects: [],
    },
    worktree_path: null,
    created_at: createdAt,
  };
}

describe("TurnPicker", () => {
  beforeEach(() => {
    useDiffStore.setState({
      snapshotsByThread: {},
      selectedTurnMessageIdByThread: {},
    });
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("ResizeObserver", ObserverMock);
    vi.stubGlobal("IntersectionObserver", ObserverMock);
  });

  it("seeds the operand with the latest turn that changed files", async () => {
    useDiffStore.setState({
      snapshotsByThread: {
        "thread-1": [
          snapshot("msg-old", "2026-09-20T10:00:00Z", 2),
          snapshot("msg-empty", "2026-09-20T11:00:00Z", 0),
          snapshot("msg-new", "2026-09-20T12:00:00Z", 3),
        ],
      },
    });
    render(<TurnPicker threadId="thread-1" />);

    // A zero-change snapshot must not win the seed even though it is newer
    // than a real diff-turn would be.
    await waitFor(() =>
      expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBe(
        "msg-new",
      ),
    );
  });

  it("lists only turns with changes and picks one", async () => {
    useDiffStore.setState({
      snapshotsByThread: {
        "thread-1": [
          snapshot("msg-old", "2026-09-20T10:00:00Z", 2),
          snapshot("msg-empty", "2026-09-20T11:00:00Z", 0),
          snapshot("msg-new", "2026-09-20T12:00:00Z", 3),
        ],
      },
    });
    render(<TurnPicker threadId="thread-1" />);

    await userEvent.click(screen.getByTestId("turn-picker"));

    expect(screen.getByTestId("turn-picker-item-msg-new")).toBeInTheDocument();
    expect(screen.getByTestId("turn-picker-item-msg-old")).toBeInTheDocument();
    expect(
      screen.queryByTestId("turn-picker-item-msg-empty"),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("turn-picker-item-msg-old"));
    expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBe(
      "msg-old",
    );
  }, 15_000);

  it("numbers turns by order among turns with changes, not all snapshots", async () => {
    useDiffStore.setState({
      snapshotsByThread: {
        "thread-1": [
          snapshot("msg-old", "2026-09-20T10:00:00Z", 2),
          snapshot("msg-empty", "2026-09-20T11:00:00Z", 0),
          snapshot("msg-new", "2026-09-20T12:00:00Z", 3),
        ],
      },
    });
    render(<TurnPicker threadId="thread-1" />);

    // The zero-change middle snapshot must not consume a number: the two
    // diff turns are "Turn 1" and "Turn 2", with the newest seeded.
    await waitFor(() =>
      expect(screen.getByTestId("turn-picker")).toHaveTextContent("Turn 2"),
    );

    await userEvent.click(screen.getByTestId("turn-picker"));
    expect(screen.getByTestId("turn-picker-item-msg-new")).toHaveTextContent("Turn 2");
    expect(screen.getByTestId("turn-picker-item-msg-old")).toHaveTextContent("Turn 1");
  }, 15_000);

  it("reports an empty state when no turn changed files", () => {
    useDiffStore.setState({
      snapshotsByThread: {
        "thread-1": [snapshot("msg-empty", "2026-09-20T11:00:00Z", 0)],
      },
    });
    render(<TurnPicker threadId="thread-1" />);

    expect(screen.getByText("No turns yet")).toBeInTheDocument();
    expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBeUndefined();
  });
});
