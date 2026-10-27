import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewTurn } from "@mcode/contracts/models/review-comparison";
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

function selection() {
  return useDiffStore.getState().selectedTurnByThread["thread-1"];
}

describe("TurnPicker", () => {
  beforeEach(() => {
    useDiffStore.setState({
      reviewTurnsByThread: {},
      reviewTurnsErrorByThread: {},
      selectedTurnByThread: {},
    });
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("ResizeObserver", ObserverMock);
    vi.stubGlobal("IntersectionObserver", ObserverMock);
  });

  it("follows the latest turn by default and marks it latest", () => {
    seedTurns([turn("msg-old", 1, 2), turn("msg-new", 2, 3)]);
    render(<TurnPicker threadId="thread-1" />);

    expect(screen.getByTestId("turn-picker")).toHaveTextContent("Turn 2 latest");
    // Following is the absence of a pick, so rendering writes nothing.
    expect(selection()).toBeUndefined();
  });

  it("follows the newest turn even when it changed no files", () => {
    seedTurns([turn("msg-old", 1, 2), turn("msg-empty", 2, 0)]);
    render(<TurnPicker threadId="thread-1" />);

    expect(screen.getByTestId("turn-picker")).toHaveTextContent("Turn 2 latest");
  });

  it("lists turns with changes plus the latest turn, newest first, with server ordinals", async () => {
    seedTurns([
      turn("msg-gone", 1, 0, "snapshot-expired"),
      turn("msg-a", 4, 2),
      turn("msg-empty", 5, 0),
      turn("msg-b", 7, 3),
      turn("msg-latest", 9, 0),
    ]);
    render(<TurnPicker threadId="thread-1" />);
    await userEvent.click(screen.getByTestId("turn-picker"));

    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("Turn 9"),
      expect.stringContaining("Turn 7"),
      expect.stringContaining("Turn 4"),
    ]);
    expect(options[0]).toHaveTextContent("latest");
    expect(options[0]).toHaveTextContent("no file changes");
    expect(options[1]).toHaveTextContent("3 files +3 -0");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  }, 15_000);

  it("pins an older turn and drops the latest marker", async () => {
    seedTurns([turn("msg-old", 1, 2), turn("msg-new", 2, 3)]);
    render(<TurnPicker threadId="thread-1" />);
    await userEvent.click(screen.getByTestId("turn-picker"));
    await userEvent.click(screen.getByRole("option", { name: /Turn 1/ }));

    expect(selection()).toBe("msg-old");
    expect(screen.getByTestId("turn-picker")).toHaveTextContent("Turn 1");
    expect(screen.queryByTestId("turn-picker-latest")).not.toBeInTheDocument();
  }, 15_000);

  it("returns to following when the newest row is picked", async () => {
    seedTurns([turn("msg-old", 1, 2), turn("msg-new", 2, 3)]);
    useDiffStore.getState().setReviewTurnForThread("thread-1", "msg-old");
    render(<TurnPicker threadId="thread-1" />);
    expect(screen.getByTestId("turn-picker")).toHaveTextContent("Turn 1");

    await userEvent.click(screen.getByTestId("turn-picker"));
    await userEvent.click(screen.getByRole("option", { name: /Turn 2/ }));

    // "latest", not msg-new, so the view moves on when turn 3 arrives.
    expect(selection()).toBe("latest");
    expect(screen.getByTestId("turn-picker")).toHaveTextContent("Turn 2 latest");
  }, 15_000);

  it("filters rows by search text", async () => {
    seedTurns([turn("msg-a", 3, 1), turn("msg-b", 12, 2)]);
    render(<TurnPicker threadId="thread-1" />);
    await userEvent.click(screen.getByTestId("turn-picker"));
    await userEvent.type(screen.getByRole("combobox"), "3");

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("Turn 3"),
    ]);
  }, 15_000);

  it("shows placeholders while the list resolves, fails or is empty", () => {
    const { rerender } = render(<TurnPicker threadId="thread-1" />);
    expect(screen.getByText("Resolving")).toBeInTheDocument();

    useDiffStore.setState({ reviewTurnsErrorByThread: { "thread-1": "boom" } });
    rerender(<TurnPicker threadId="thread-1" />);
    expect(screen.getByText("Turns unavailable")).toBeInTheDocument();

    seedTurns([]);
    rerender(<TurnPicker threadId="thread-1" />);
    expect(screen.getByText("No turns yet")).toBeInTheDocument();
    expect(selection()).toBeUndefined();
  });

  it("closes when another tool takes the panel header and stays closed on return", async () => {
    seedTurns([turn("msg-new", 1, 3)]);
    const elements = { leading: document.createElement("div"), row2: document.createElement("div"), row3: null };
    const picker = (active: boolean) => (
      <PanelHeaderSlotScope active={active} elements={elements}>
        <TurnPicker threadId="thread-1" />
      </PanelHeaderSlotScope>
    );
    const { rerender } = render(picker(true));
    await userEvent.click(screen.getByTestId("turn-picker"));
    expect(screen.getByRole("option", { name: /Turn 1/ })).toBeInTheDocument();

    rerender(picker(false));
    await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());

    rerender(picker(true));
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  }, 15_000);
});
