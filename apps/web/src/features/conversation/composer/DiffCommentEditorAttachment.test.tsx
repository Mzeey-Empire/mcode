import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { DiffCommentEditorAttachment } from "./DiffCommentEditorAttachment";

const lineTarget = {
  filePath: "src/state.ts",
  side: "right" as const,
  line: 11,
  lineContent: "const state = nextState;",
};

function renderAttachment(threadId?: string) {
  return render(
    <DiffCommentEditorAttachment
      scopeId="thread-1"
      threadId={threadId}
      workspaceId="ws-1"
    />,
  );
}

describe("DiffCommentEditorAttachment", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({
      byThread: {},
      diffByThread: {},
      drafts: {},
      diffEditTargets: {},
    });
  });

  it("renders the editor card for an active draft target", () => {
    usePreviewAnnotationStore
      .getState()
      .setDiffEditTarget("thread-1", { kind: "draft", ...lineTarget });
    renderAttachment("thread-1");
    expect(
      screen.getByRole("dialog", { name: "Comment on src/state.ts line 11" }),
    ).toBeInTheDocument();
    expect(screen.getByText("state.ts:11")).toBeInTheDocument();
  });

  it("renders nothing without an active target", () => {
    const { container } = renderAttachment("thread-1");
    expect(container).toBeEmptyDOMElement();
  });

  it("resolves an edit target to the saved annotation", () => {
    const saved = usePreviewAnnotationStore
      .getState()
      .saveDiffAnnotation("thread-1", { ...lineTarget, note: "Existing note" });
    usePreviewAnnotationStore
      .getState()
      .setDiffEditTarget("thread-1", { kind: "edit", annotationId: saved.id });
    renderAttachment("thread-1");
    expect(
      screen.getByRole("button", { name: "Delete comment" }),
    ).toBeInTheDocument();
  });

  it("renders nothing when the edit target's annotation is gone", () => {
    usePreviewAnnotationStore
      .getState()
      .setDiffEditTarget("thread-1", { kind: "edit", annotationId: "missing" });
    const { container } = renderAttachment("thread-1");
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the composer is not bound to a thread", () => {
    usePreviewAnnotationStore
      .getState()
      .setDiffEditTarget("thread-1", { kind: "draft", ...lineTarget });
    const { container } = renderAttachment(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("clears the edit target when the editor closes", () => {
    usePreviewAnnotationStore
      .getState()
      .setDiffEditTarget("thread-1", { kind: "draft", ...lineTarget });
    renderAttachment("thread-1");
    screen.getByRole("button", { name: "Close comment editor" }).click();
    expect(
      usePreviewAnnotationStore.getState().diffEditTargets["thread-1"],
    ).toBeUndefined();
  });
});
