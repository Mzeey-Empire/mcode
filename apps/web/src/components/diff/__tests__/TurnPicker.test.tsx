import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewTurn } from "@mcode/contracts";
import { useDiffStore } from "@/stores/diffStore";
import { PanelHeaderSlotScope } from "@/components/panels/shell/PanelHeader";
import { TurnPicker } from "../TurnPicker";

class ObserverMock {
  observe = () => {};
  unobserve = () => {};
  disconnect = () => {};
}

function turn(
  messageId: string,
  ordinal: number,
  fileCount: number,
  availability: ReviewTurn["availability"] = "available",
): ReviewTurn {
  return {
    messageId,
    ordinal,
    createdAt: `2026-09-20T1${ordinal}:00:00Z`,
    phase: "settled",
    fileCount,
    additions: fileCount > 0 ? fileCount : null,
    deletions: fileCount > 0 ? 0 : null,
    evidence: fileCount > 0 ? "native" : null,
    availability,
  };
}

function seedTurns(turns: readonly ReviewTurn[]) {
  useDiffStore.setState({ reviewTurnsByThread: { "thread-1": [...turns] } });
}

describe("TurnPicker", () => {
  beforeEach(() => {
    useDiffStore.setState({
      reviewTurnsByThread: {},
      selectedTurnMessageIdByThread: {},
    });
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("ResizeObserver", ObserverMock);
    vi.stubGlobal("IntersectionObserver", ObserverMock);
  });

  it("seeds the operand with the latest turn that changed files", async () => {
    seedTurns([turn("msg-old", 1, 2), turn("msg-new", 2, 3), turn("msg-empty", 3, 0)]);
    render(<TurnPicker threadId="thread-1" />);

    // A newer turn without file changes must not win the seed.
    await waitFor(() =>
      expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBe("msg-new"),
    );
  });

  it("seeds the latest turn when no turn changed files", async () => {
    seedTurns([turn("msg-a", 1, 0), turn("msg-b", 2, 0)]);
    render(<TurnPicker threadId="thread-1" />);

    await waitFor(() =>
      expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBe("msg-b"),
    );
  });

  it("lists every turn with its server ordinal and labels empty and gone turns", async () => {
    seedTurns([
      turn("msg-gone", 1, 0, "snapshot-expired"),
      turn("msg-empty", 2, 0),
      turn("msg-new", 3, 3),
    ]);
    render(<TurnPicker threadId="thread-1" />);

    await waitFor(() => expect(screen.getByTestId("turn-picker")).toHaveTextContent("Turn 3"));
    await userEvent.click(screen.getByTestId("turn-picker"));

    expect(screen.getByTestId("turn-picker-item-msg-new")).toHaveTextContent("Turn 3");
    expect(screen.getByTestId("turn-picker-item-msg-new")).toHaveTextContent("3 files · +3 −0");
    expect(screen.getByTestId("turn-picker-item-msg-empty")).toHaveTextContent("Turn 2");
    expect(screen.getByTestId("turn-picker-item-msg-empty")).toHaveTextContent("no file changes");
    expect(screen.getByTestId("turn-picker-item-msg-gone")).toHaveTextContent("Turn 1");
    expect(screen.getByTestId("turn-picker-item-msg-gone")).toHaveTextContent("changes gone");

    await userEvent.click(screen.getByTestId("turn-picker-item-msg-empty"));
    expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBe("msg-empty");
  }, 15_000);

  it("reports an empty state when the thread has no turns", () => {
    seedTurns([]);
    render(<TurnPicker threadId="thread-1" />);

    expect(screen.getByText("No turns yet")).toBeInTheDocument();
    expect(useDiffStore.getState().selectedTurnMessageIdByThread["thread-1"]).toBeUndefined();
  });

  it("closes when another tool takes the panel header and stays closed on return", async () => {
    seedTurns([turn("msg-new", 1, 3)]);
    const elements = { leading: document.createElement("div"), row2: document.createElement("div") };
    const picker = (active: boolean) => (
      <PanelHeaderSlotScope active={active} elements={elements}>
        <TurnPicker threadId="thread-1" />
      </PanelHeaderSlotScope>
    );
    const { rerender } = render(picker(true));
    await userEvent.click(screen.getByTestId("turn-picker"));
    expect(screen.getByTestId("turn-picker-item-msg-new")).toBeInTheDocument();

    rerender(picker(false));
    await waitFor(() => expect(screen.queryByTestId("turn-picker-item-msg-new")).not.toBeInTheDocument());

    rerender(picker(true));
    expect(screen.queryByTestId("turn-picker-item-msg-new")).not.toBeInTheDocument();
  }, 15_000);
});
