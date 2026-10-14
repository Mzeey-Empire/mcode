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

/**
 * The comment followed back through the older versions it was carried from,
 * oldest first. Deleting only the newest copy would put its original back on
 * the composer chip.
 */
function carryChain(comments: readonly PlanComment[], id: string): string[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const chain: string[] = [];
  for (let current = byId.get(id); current; current = current.carriedFromCommentId ? byId.get(current.carriedFromCommentId) : undefined) {
    chain.unshift(current.id);
  }
  return chain;
}

/** Deletes a saved comment with the older copies it was carried from, and closes its editor. */
export async function deletePlanComment(threadId: string, commentId: string): Promise<string | null> {
  const chain = carryChain(usePlanStore.getState().commentsByThread[threadId] ?? [], commentId);
  try {
    // Oldest first, so a failure part way never leaves an older note riding alone.
    for (const id of chain.length > 0 ? chain : [commentId]) {
      await getTransport().deletePlanComment({ commentId: id });
      usePlanStore.getState().applyCommentsChanged(threadId, [], [id]);
    }
    const open = useComposerDraftStore.getState().drafts[threadId]?.planCommentEditor;
    if (open?.commentId && chain.includes(open.commentId)) setPlanCommentEditor(threadId, undefined);
    return null;
  } catch (error) {
    return planCommentErrorMessage(error);
  }
}

/** Puts back a deleted comment under its own id on the version it was written on. */
async function restorePlanComments(threadId: string, comments: readonly PlanComment[]): Promise<void> {
  try {
    for (const comment of comments) {
      const saved = await getTransport().createPlanComment({
        commentId: comment.id,
        versionId: comment.versionId,
        anchor: comment.anchor,
        body: comment.body,
      });
      usePlanStore.getState().applyCommentsChanged(threadId, [saved], []);
    }
  } catch (error) {
    useToastStore.getState().show({
      kind: "failed",
      title: "Could not restore the plan comments",
      meta: planCommentErrorMessage(error),
    });
  }
}

/** Deletes the plan comments riding the next Send, offering an Undo toast that restores them. */
export async function removePlanCommentsFromSend(threadId: string, comments: readonly PlanComment[]): Promise<void> {
  const toasts = useToastStore.getState();
  const removed: PlanComment[] = [];
  for (const comment of comments) {
    const failure = await deletePlanComment(threadId, comment.id);
    if (failure) {
      toasts.show({ kind: "failed", title: "Could not remove the plan comments", meta: failure });
      break;
    }
    removed.push(comment);
  }
  if (removed.length === 0) return;
  toasts.show({
    kind: "info",
    title: removed.length === 1 ? "Plan comment removed" : `${removed.length} plan comments removed`,
    meta: "Undo",
    dedupeKey: `plan-comments-removed:${removed[0]!.id}`,
    onOpen: () => void restorePlanComments(threadId, removed),
  });
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
