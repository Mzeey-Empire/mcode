import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StickyUserMessage } from "../StickyUserMessage";
import type { UserMessagePreview } from "../user-message-preview";

const plain = (text: string): UserMessagePreview => ({ kind: "plain", text });

describe("StickyUserMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the preview and jumps when the jump control is clicked", () => {
    const onJumpToMessage = vi.fn();
    render(
      <StickyUserMessage
        preview={plain("Refactor the scroll container")}
        visible
        onJumpToMessage={onJumpToMessage}
      />,
    );

    expect(screen.getByTestId("sticky-user-message")).toBeInTheDocument();
    expect(screen.getByText("Refactor the scroll container")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Jump to your message" }));
    expect(onJumpToMessage).toHaveBeenCalledTimes(1);
  });

  function overflowWhenTaller(heights: { scroll: number }) {
    class ManualResizeObserver implements ResizeObserver {
      static readonly all: ManualResizeObserver[] = [];
      constructor(readonly callback: ResizeObserverCallback) { ManualResizeObserver.all.push(this); }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ManualResizeObserver);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => heights.scroll);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(52);
    return () => act(() => ManualResizeObserver.all.forEach((observer) => observer.callback([], observer)));
  }

  it("offers no Show all when the prompt fits", () => {
    overflowWhenTaller({ scroll: 40 });
    render(<StickyUserMessage preview={plain("Short prompt")} visible onJumpToMessage={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Show full message" })).toBeNull();
  });

  it("offers Show all once a narrower transcript makes the prompt overflow", () => {
    const heights = { scroll: 40 };
    const resize = overflowWhenTaller(heights);
    render(<StickyUserMessage preview={plain("word ".repeat(60))} visible onJumpToMessage={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Show full message" })).toBeNull();
    heights.scroll = 120;
    resize();
    expect(screen.getByRole("button", { name: "Show full message" })).toBeInTheDocument();
  });

  it("toggles an overflowing prompt between Show all and Show less without jumping", () => {
    overflowWhenTaller({ scroll: 120 });
    const onJumpToMessage = vi.fn();
    render(<StickyUserMessage preview={plain("word ".repeat(60))} visible onJumpToMessage={onJumpToMessage} />);

    const showAll = screen.getByRole("button", { name: "Show full message" });
    expect(showAll).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(showAll);
    const showLess = screen.getByRole("button", { name: "Show less" });
    expect(showLess).toHaveAttribute("aria-expanded", "true");
    expect(onJumpToMessage).not.toHaveBeenCalled();

    fireEvent.click(showLess);
    expect(screen.getByRole("button", { name: "Show full message" })).toHaveAttribute("aria-expanded", "false");
  });

  it("unmounts when hidden so focused controls are not aria-hidden", () => {
    const onJumpToMessage = vi.fn();
    const { rerender } = render(
      <StickyUserMessage
        preview={plain("Short prompt")}
        visible
        onJumpToMessage={onJumpToMessage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Jump to your message" }));
    rerender(
      <StickyUserMessage
        preview={plain("Short prompt")}
        visible={false}
        onJumpToMessage={onJumpToMessage}
      />,
    );

    expect(screen.queryByTestId("sticky-user-message")).not.toBeInTheDocument();
  });

  it("renders mention previews as entity tokens instead of raw text", () => {
    render(
      <StickyUserMessage
        preview={{
          kind: "mentions",
          text: "/architect review @README.md",
          mentions: [
            { id: "command:skill:architect", kind: "command", label: "architect", namespace: "skill", range: { start: 0, end: 10 } },
            { id: "file-1", kind: "file", label: "README.md", path: "README.md", range: { start: 18, end: 28 } },
          ],
        }}
        visible
        onJumpToMessage={vi.fn()}
      />,
    );

    const bar = screen.getByTestId("sticky-user-message");
    expect(bar.querySelector('[data-entity-token="skill"]')).toHaveTextContent("architect");
    expect(bar.querySelector('[data-entity-token="file"]')).not.toBeNull();
    expect(bar).not.toHaveTextContent("/architect");
  });
});
