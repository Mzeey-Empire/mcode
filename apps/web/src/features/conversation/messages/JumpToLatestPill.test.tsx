import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageListOverlays } from "./MessageListOverlays";

function renderOverlays(showJumpToLatest: boolean, onJumpToLatest = vi.fn()) {
  render(
    <MessageListOverlays
      handoffStatus={undefined}
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

  it("stays neutral with no primary or destructive colour", () => {
    renderOverlays(true);
    const pill = screen.getByRole("button", { name: "Jump to latest" });
    expect(pill.className).not.toMatch(/primary|destructive/);
  });
});
