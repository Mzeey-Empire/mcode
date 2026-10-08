import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LexicalEditor } from "lexical";
import {
  DiffAnnotationPayloadSchema,
  MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS,
  type DraftDiffComment,
  type MessageMention,
} from "@mcode/contracts";
import { writeComposerContent } from "@/features/conversation/composer/draft/composer-editor-content";
import {
  canSaveDiffComment,
  saveDraftDiffComment,
} from "@/features/conversation/composer/draft/draft-diff-comments";
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

  it("saves a 5,000-character note with a mention that the send payload accepts", async () => {
    const { editorRef } = renderEditor();
    const note = `@state.ts ${"x".repeat(4990)}`;

    await type(editorRef, note, [fileMention]);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled());
    screen.getByRole("button", { name: "Add comment" }).click();

    const saved = draft()!.diffComments![0]!;
    expect(saved.note).toHaveLength(5000);
    expect(DiffAnnotationPayloadSchema().safeParse(saved).success).toBe(true);
  });

  it("keeps leading spaces so mention ranges still point at the mention", async () => {
    const { editorRef } = renderEditor();
    const spacedMention = { ...fileMention, range: { start: 2, end: 11 } };

    await type(editorRef, "  @state.ts explain", [spacedMention]);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled());
    screen.getByRole("button", { name: "Add comment" }).click();

    const saved = draft()!.diffComments![0]!;
    expect(saved.note.slice(2, 11)).toBe("@state.ts");
    expect(saved.mentions).toEqual([spacedMention]);
  });
});

describe("canSaveDiffComment", () => {
  it("uses the payload's note-plus-mentions budget", () => {
    const atLimit = "x".repeat(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS);
    const fitsWithEmptyMentions = "x".repeat(MAX_SELECTED_TEXT_COMMENT_TEXT_CHARS - 2);

    expect(canSaveDiffComment(atLimit, [])).toBe(false);
    expect(canSaveDiffComment(fitsWithEmptyMentions, [])).toBe(true);
    expect(canSaveDiffComment("   ", [])).toBe(false);
  });
});
