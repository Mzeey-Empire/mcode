import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { useDiffStore } from "@/stores/diffStore";
import { DiffCommentsComposerAttachment } from "./DiffCommentsComposerAttachment";

const SCOPE = "thread-1";
const WORKSPACE = "workspace-1";

function seedComments(count = 2) {
  return Array.from({ length: count }, (_, index) =>
    usePreviewAnnotationStore.getState().saveDiffAnnotation(SCOPE, {
      filePath: `src/file-${index}.ts`,
      side: "right",
      line: 10 + index,
      lineContent: `const value${index} = ${index};`,
      note: `Note ${index}`,
    }));
}

function renderAttachment(commentCount = 2) {
  const comments = seedComments(commentCount);
  const onFocusComposer = vi.fn();
  render(
    <DiffCommentsComposerAttachment
      comments={comments}
      scopeId={SCOPE}
      workspaceId={WORKSPACE}
      threadId={SCOPE}
      onFocusComposer={onFocusComposer}
    />,
  );
  return { comments, onFocusComposer };
}

function openPreview() {
  fireEvent.click(
    screen.getByRole("button", { name: /comments?\. Preview available\./ }),
  );
}

describe("DiffCommentsComposerAttachment", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, diffByThread: {}, drafts: {} });
    useDiffStore.setState({
      showRightPanel: vi.fn(),
      setRightPanelTab: vi.fn(),
      requestReviewFileJump: vi.fn(),
    });
  });

  it("renders the count pill and a spaced preview card per comment", () => {
    renderAttachment(2);
    expect(screen.getByTestId("diff-comment-chip")).toHaveTextContent("2 comments");

    openPreview();

    const preview = screen.getByTestId("diff-comment-preview");
    expect(preview).toHaveTextContent("1. src/file-0.ts:10:");
    expect(preview).toHaveTextContent("const value0 = 0;");
    expect(preview).toHaveTextContent("Note 0");
    expect(preview).toHaveTextContent("2. src/file-1.ts:11:");
    expect(preview).toHaveTextContent("Note 1");
  });

  it("opens the Review surface jumped to the comment file", () => {
    renderAttachment(1);
    openPreview();

    fireEvent.click(screen.getByRole("button", { name: "Open source for comment 1" }));

    const state = useDiffStore.getState();
    expect(state.showRightPanel).toHaveBeenCalledWith(WORKSPACE, SCOPE);
    expect(state.setRightPanelTab).toHaveBeenCalledWith(WORKSPACE, SCOPE, "changes");
    expect(state.requestReviewFileJump).toHaveBeenCalledWith(SCOPE, "src/file-0.ts");
  });

  it("removes every diff comment from the store via the chip dismiss", () => {
    renderAttachment(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove 2 comments" }));

    expect(usePreviewAnnotationStore.getState().diffByThread[SCOPE]).toEqual([]);
  });

  it("deletes a single comment from its card without touching the others", () => {
    renderAttachment(2);
    openPreview();

    fireEvent.pointerEnter(screen.getByTestId("diff-comment-preview-item-1"));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment 1" }));

    const remaining = usePreviewAnnotationStore.getState().diffByThread[SCOPE];
    expect(remaining).toHaveLength(1);
    expect(remaining?.[0]?.filePath).toBe("src/file-1.ts");
  });
});
