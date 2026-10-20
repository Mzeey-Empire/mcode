import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageListOverlays } from "./MessageListOverlays";

function renderOverlays(showJumpToLatest: boolean, onJumpToLatest = vi.fn(), contentPaddingRight?: string) {
  render(
    <MessageListOverlays
      messages={[]}
      isLoadingMore={false}
      isLoadingNewer={false}
      onSelectedTextComment={undefined}
      onDeleteSelectedTextComment={undefined}
      onSelectedTextCommentEditorChange={undefined}
      selectedTextCommentEditor={undefined}
      selectedTextCommentEditorScope={undefined}
      onOpenSelectedTextCommentEditor={undefined}
      viewportRef={{ current: null }}
      renderedThreadId="thread-1"
      stickyPreview={null}
      contentPaddingRight={contentPaddingRight}
      isStickyVisible={false}
      onJumpToUserMessage={vi.fn()}
      onStickyHeightChange={vi.fn()}
      showJumpToLatest={showJumpToLatest}
      onJumpToLatest={onJumpToLatest}
    />,
  );
  return onJumpToLatest;
}

describe("Jump to latest pill", () => {
  it("is absent while the reader is at the tail", () => {
    renderOverlays(false);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("returns the reader to the tail when clicked", () => {
    const onJumpToLatest = renderOverlays(true);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
  });

  it("keeps the docked overview's reserve out of the pill's centring box", () => {
    renderOverlays(true, vi.fn(), "328px");
    const fade = screen.getByRole("button", { name: "Jump to latest" }).parentElement?.parentElement;
    expect(fade?.style.right).toBe("328px");
  });
});
