import type { PlanComment, PlanCommentAnchor, PlanCommentEditorDraft } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { RpcError } from "@/transport/ws-transport";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePlanStore } from "@/stores/planStore";
import { useToastStore } from "@/stores/toastStore";

/** Shown when a comment write fails; the editor keeps the note so nothing typed is lost. */
export function planCommentErrorMessage(error: unknown): string {
  if (error instanceof RpcError) {
    switch (error.code) {
      case "plan_read_only":
        return "This plan version is accepted, so it no longer takes comments.";
      case "plan_busy":
        return "The plan is busy. Try again when the run finishes.";
      case "plan_comment_invalid":
        return "The plan changed under this comment. Select the text again.";
    }
  }
  return error instanceof Error ? error.message : "Could not save the comment.";
}

/** Writes the thread's persisted composer editor; undefined closes it. */
export function setPlanCommentEditor(threadId: string, editor: PlanCommentEditorDraft | undefined): void {
  useComposerDraftStore.getState().updateNextMessage(threadId, (draft) => ({ ...draft, planCommentEditor: editor }));
}

/** Closes the editor only if it is still the one a write was issued for; a slow reply must not discard a newer editor. */
function closePlanCommentEditorFor(threadId: string, submitted: PlanCommentEditorDraft): void {
  const current = useComposerDraftStore.getState().drafts[threadId]?.planCommentEditor;
  if (!current || current.commentId !== submitted.commentId || current.planVersionId !== submitted.planVersionId) return;
  if (current.body.trim() !== submitted.body.trim()) return;
  if (current.anchor.kind === "text" && submitted.anchor.kind === "text" && current.anchor.start !== submitted.anchor.start) return;
  setPlanCommentEditor(threadId, undefined);
}

/** Edits the note of the open editor. */
export function setPlanCommentEditorBody(threadId: string, body: string): void {
  useComposerDraftStore.getState().updateNextMessage(threadId, (draft) =>
    draft.planCommentEditor ? { ...draft, planCommentEditor: { ...draft.planCommentEditor, body } } : draft,
  );
}

/** What {@link savePlanComment} needs beyond the editor draft. */
export interface SavePlanCommentInput {
  readonly versionId: string;
  /** Identity for a new comment; reused on retry so a lost reply cannot create two. */
  readonly newCommentId: string;
  readonly anchor: PlanCommentAnchor;
  readonly body: string;
}

/**
 * Creates the comment, or updates its note when the editor holds a saved one.
 * Closes the editor on success and returns an error message on failure,
 * leaving the editor open with its note.
 */
export async function savePlanComment(
  threadId: string,
  editor: PlanCommentEditorDraft,
  input: SavePlanCommentInput,
): Promise<string | null> {
  const body = input.body.trim();
  if (body === "") return "Write a note first.";
  const transport = getTransport();
  const existing = editor.commentId
    ? usePlanStore.getState().commentsByThread[threadId]?.find((comment) => comment.id === editor.commentId)
    : undefined;
  try {
    const saved = existing
      ? await transport.updatePlanComment({ commentId: existing.id, body })
      : await transport.createPlanComment({
          commentId: input.newCommentId,
          versionId: input.versionId,
          anchor: input.anchor,
          body,
        });
    usePlanStore.getState().applyCommentsChanged(threadId, [saved], []);
    closePlanCommentEditorFor(threadId, editor);
    return null;
  } catch (error) {
    return planCommentErrorMessage(error);
  }
}

/** Deletes a saved comment and closes its editor. */
export async function deletePlanComment(threadId: string, commentId: string): Promise<string | null> {
  try {
    await getTransport().deletePlanComment({ commentId });
    usePlanStore.getState().applyCommentsChanged(threadId, [], [commentId]);
    const open = useComposerDraftStore.getState().drafts[threadId]?.planCommentEditor;
    if (open?.commentId === commentId) setPlanCommentEditor(threadId, undefined);
    return null;
  } catch (error) {
    return planCommentErrorMessage(error);
  }
}

async function writeStatus(threadId: string, commentId: string, status: PlanComment["status"]): Promise<void> {
  const saved = await getTransport().setPlanCommentStatus({ commentId, status });
  usePlanStore.getState().applyCommentsChanged(threadId, [saved], []);
}

/** Resolves a comment, offering an Undo toast that reopens it. */
export async function resolvePlanComment(threadId: string, commentId: string): Promise<void> {
  const toasts = useToastStore.getState();
  try {
    await writeStatus(threadId, commentId, "resolved");
  } catch (error) {
    toasts.show({ kind: "failed", title: "Could not resolve the comment", meta: planCommentErrorMessage(error) });
    return;
  }
  toasts.show({
    kind: "info",
    title: "Comment resolved",
    meta: "Undo",
    dedupeKey: `plan-comment-resolved:${commentId}`,
    onOpen: () => {
      writeStatus(threadId, commentId, "open").catch((error: unknown) => {
        useToastStore.getState().show({
          kind: "failed",
          title: "Could not reopen the comment",
          meta: planCommentErrorMessage(error),
        });
      });
    },
  });
}
