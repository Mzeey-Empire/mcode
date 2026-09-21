import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LexicalEditor } from "lexical";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { DiffCommentEditor } from "../DiffCommentEditor";

const target = {
  filePath: "src/state.ts",
  side: "right" as const,
  line: 11,
  lineContent: "const state = nextState;",
};

function renderEditor(annotation?: Parameters<typeof DiffCommentEditor>[0]["annotation"]) {
  const editorRef: { current: LexicalEditor | null } = { current: null };
  const onClose = vi.fn();
  render(
    <DiffCommentEditor
      threadId="thread-1"
      target={target}
      annotation={annotation}
      editorRef={editorRef}
      onClose={onClose}
    />,
  );
  return { editorRef, onClose };
}

describe("DiffCommentEditor", () => {
  beforeEach(() => {
    usePreviewAnnotationStore.setState({ byThread: {}, diffByThread: {}, drafts: {}, diffEditTargets: {} });
  });

  it("saves a new line comment into the thread annotation bundle", async () => {
    const { editorRef, onClose } = renderEditor();

    await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
    await act(async () => {
      writeComposerContent(editorRef.current!, "Keep this immutable");
    });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled());

    screen.getByRole("button", { name: "Add comment" }).click();

    expect(usePreviewAnnotationStore.getState().diffByThread["thread-1"]).toMatchObject([
      {
        kind: "diff",
        filePath: "src/state.ts",
        side: "right",
        line: 11,
        lineContent: "const state = nextState;",
        note: "Keep this immutable",
      },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("deletes an existing comment through the shared controls", () => {
    const saved = usePreviewAnnotationStore.getState().saveDiffAnnotation("thread-1", {
      ...target,
      note: "Existing note",
    });
    const { onClose } = renderEditor(saved);

    screen.getByRole("button", { name: "Delete comment" }).click();

    expect(usePreviewAnnotationStore.getState().diffByThread["thread-1"]).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });
});
