import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LexicalEditor } from "lexical";
import type { DraftDiffComment, MessageMention } from "@mcode/contracts";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import { saveDraftDiffComment } from "@/features/conversation/composer/draft/draft-diff-comments";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { DiffCommentEditor } from "../DiffCommentEditor";

const THREAD_ID = "thread-1";
const target = {
  filePath: "src/state.ts",
  side: "right" as const,
  line: 11,
  lineContent: "const state = nextState;",
};
const fileMention: MessageMention = {
  kind: "file",
  id: "file-1",
  label: "state.ts",
  path: "src/state.ts",
  range: { start: 0, end: 9 },
};

function draft() {
  return useComposerDraftStore.getState().drafts[THREAD_ID];
}

function renderEditor(annotation?: DraftDiffComment) {
  const editorRef: { current: LexicalEditor | null } = { current: null };
  const onClose = vi.fn();
  const view = render(
    <DiffCommentEditor
      threadId={THREAD_ID}
      target={target}
      annotation={annotation}
      editorRef={editorRef}
      onClose={onClose}
    />,
  );
  return { editorRef, onClose, view };
}

async function type(editorRef: { current: LexicalEditor | null }, text: string, mentions: MessageMention[] = []) {
  await vi.waitFor(() => expect(editorRef.current).not.toBeNull());
  await act(async () => {
    writeComposerContent(editorRef.current!, text, mentions);
  });
}

describe("DiffCommentEditor", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
  });

  it("saves a comment with its mentions into the thread's composer draft", async () => {
    const { editorRef, onClose } = renderEditor();

    await type(editorRef, "@state.ts keep this immutable", [fileMention]);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled());
    screen.getByRole("button", { name: "Add comment" }).click();

    expect(draft()?.diffComments).toEqual([
      expect.objectContaining({
        kind: "diff",
        revision: 1,
        ...target,
        note: "@state.ts keep this immutable",
        mentions: [fileMention],
      }),
    ]);
    expect(draft()?.diffCommentEditor).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps unsaved text and mentions in the draft and restores them in a new editor", async () => {
    const first = renderEditor();
    await type(first.editorRef, "@state.ts unsaved thought", [fileMention]);

    expect(draft()?.diffCommentEditor).toEqual({
      target,
      annotationId: undefined,
      note: "@state.ts unsaved thought",
      mentions: [fileMention],
    });

    first.view.unmount();
    const second = renderEditor();
    await vi.waitFor(() =>
      expect(second.editorRef.current?.getEditorState().read(() => document.body.textContent)).toContain(
        "unsaved thought",
      ));
  });

  it("writes a new revision when an edit is saved", async () => {
    saveDraftDiffComment(THREAD_ID, target, { note: "Existing note", mentions: [] });
    const saved = draft()!.diffComments![0]!;
    const { editorRef } = renderEditor(saved);

    await type(editorRef, "Edited note");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Save comment" })).toBeEnabled());
    screen.getByRole("button", { name: "Save comment" }).click();

    expect(draft()?.diffComments).toEqual([
      expect.objectContaining({ id: saved.id, revision: 2, note: "Edited note" }),
    ]);
  });

  it("deletes an existing comment through the shared controls", () => {
    saveDraftDiffComment(THREAD_ID, target, { note: "Existing note", mentions: [] });
    const { onClose } = renderEditor(draft()!.diffComments![0]);

    screen.getByRole("button", { name: "Delete comment" }).click();

    expect(draft()).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });
});
