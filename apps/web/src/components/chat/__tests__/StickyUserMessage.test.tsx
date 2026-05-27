import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StickyUserMessage } from "../StickyUserMessage";

describe("StickyUserMessage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the preview and jumps when the jump control is clicked", () => {
    const onJumpToMessage = vi.fn();
    render(
      <StickyUserMessage
        preview="Refactor the scroll container"
        visible
        onJumpToMessage={onJumpToMessage}
      />,
    );

    expect(screen.getByTestId("sticky-user-message")).toBeInTheDocument();
    expect(screen.getByText("Refactor the scroll container")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Jump to your last message" }));
    expect(onJumpToMessage).toHaveBeenCalledTimes(1);
  });

  it("jumps short previews when the preview area is clicked", () => {
    const onJumpToMessage = vi.fn();
    render(
      <StickyUserMessage
        preview="Short prompt"
        visible
        onJumpToMessage={onJumpToMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump to your last message in transcript" }));
    expect(onJumpToMessage).toHaveBeenCalledTimes(1);
  });

  it("expands long previews on single click without triggering jump", () => {
    vi.useFakeTimers();
    const onJumpToMessage = vi.fn();
    const preview = "A".repeat(180);
    render(
      <StickyUserMessage
        preview={preview}
        visible
        onJumpToMessage={onJumpToMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand your last message" }));
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onJumpToMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Collapse your last message" })).toBeInTheDocument();
    expect(screen.getByText("Collapse")).toBeInTheDocument();
  });

  it("jumps long previews on double click without expanding", () => {
    vi.useFakeTimers();
    const onJumpToMessage = vi.fn();
    const preview = "A".repeat(180);
    render(
      <StickyUserMessage
        preview={preview}
        visible
        onJumpToMessage={onJumpToMessage}
      />,
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "Expand your last message" }));
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onJumpToMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Expand your last message" })).toBeInTheDocument();
  });

  it("collapses an expanded long preview on single click", () => {
    vi.useFakeTimers();
    const preview = "A".repeat(180);
    render(
      <StickyUserMessage
        preview={preview}
        visible
        onJumpToMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand your last message" }));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.click(screen.getByRole("button", { name: "Collapse your last message" }));
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(screen.getByRole("button", { name: "Expand your last message" })).toBeInTheDocument();
  });

  it("exposes screen-reader hint for double-click jump on long previews", () => {
    const preview = "A".repeat(180);
    render(
      <StickyUserMessage
        preview={preview}
        visible
        onJumpToMessage={vi.fn()}
      />,
    );

    const previewButton = screen.getByRole("button", { name: "Expand your last message" });
    expect(previewButton).toHaveAttribute(
      "aria-describedby",
      "sticky-user-message-preview-hint",
    );
    expect(
      screen.getByText("Double-click to jump to your message in the transcript"),
    ).toHaveClass("sr-only");
  });

  it("unmounts when hidden so focused controls are not aria-hidden", () => {
    const onJumpToMessage = vi.fn();
    const { rerender } = render(
      <StickyUserMessage
        preview="Short prompt"
        visible
        onJumpToMessage={onJumpToMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump to your last message in transcript" }));
    rerender(
      <StickyUserMessage
        preview="Short prompt"
        visible={false}
        onJumpToMessage={onJumpToMessage}
      />,
    );

    expect(screen.queryByTestId("sticky-user-message")).not.toBeInTheDocument();
  });

  it("reports zero height when hidden", () => {
    const onHeightChange = vi.fn();
    const { rerender } = render(
      <StickyUserMessage
        preview="Short prompt"
        visible
        onJumpToMessage={vi.fn()}
        onHeightChange={onHeightChange}
      />,
    );

    rerender(
      <StickyUserMessage
        preview="Short prompt"
        visible={false}
        onJumpToMessage={vi.fn()}
        onHeightChange={onHeightChange}
      />,
    );

    expect(onHeightChange).toHaveBeenCalledWith(0);
  });
});
