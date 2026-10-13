import { useCallback, useRef, useState } from "react";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import {
  MCODE_BROWSER_CAPTURE_FENCE_CLOSE,
  MCODE_BROWSER_CAPTURE_FENCE_OPEN,
} from "@/features/preview/capture/browser-capture-append";
import { useQueueStore, type QueuedApprovalNote, type QueuedMessage } from "@/stores/queueStore";
import { scheduleDrainAfterEdit } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { discardApprovalNote, saveApprovalNoteEdit, setApprovalNoteInEdit } from "./queued-approval-note";

/** The queue slot currently restored into the Composer for editing. */
export interface ComposerQueueEdit {
  messageId: string;
  originalIndex: number;
  /** Set when the slot holds a deny note, whose edits the server must save. */
  approvalNote?: QueuedApprovalNote;
}

/** The live Composer operations needed to restore or clear a queued message. */
export interface ComposerQueueEditForm {
  hasContent: () => boolean;
  capture: (
    restoredPreviewAnnotations: PreviewAnnotationBundle | undefined,
  ) => Omit<QueuedMessage, "id" | "queuedAt">;
  restore: (message: QueuedMessage) => void;
  clear: () => void;
  invalidateAttachments: () => void;
}

/** The preview annotation operations coupled to a queue-edit lifecycle. */
export interface ComposerQueueEditAnnotations {
  restore: (bundle: PreviewAnnotationBundle | undefined) => void;
  clear: () => void;
}

/** Inputs that connect queue editing to the current Composer form and annotation state. */
export interface UseComposerQueueEditingOptions {
  threadId: string | undefined;
  form: ComposerQueueEditForm;
  annotations: ComposerQueueEditAnnotations;
}

function toQueuePayload(message: QueuedMessage): Omit<QueuedMessage, "id" | "queuedAt"> {
  const { id, queuedAt, ...payload } = message;
  void id;
  void queuedAt;
  return payload;
}

/** Retains a preview capture when a user edits the surrounding queued message text. */
function preserveBrowserCapturePayload(
  payload: Omit<QueuedMessage, "id" | "queuedAt">,
  original: QueuedMessage | null,
): Omit<QueuedMessage, "id" | "queuedAt"> {
  if (!original) return payload;
  const start = original.content.indexOf(MCODE_BROWSER_CAPTURE_FENCE_OPEN);
  const closeIndex = original.content.indexOf(MCODE_BROWSER_CAPTURE_FENCE_CLOSE, start);
  if (start === -1 || closeIndex === -1) return payload;
  const end = closeIndex + MCODE_BROWSER_CAPTURE_FENCE_CLOSE.length;
  const browserCaptureFence = original.content.slice(start, end);
  const browserCaptureSpillPaths = [
    ...(payload.browserCaptureSpillPaths ?? []),
    ...(original.browserCaptureSpillPaths ?? []),
  ];
  return {
    ...payload,
    content: `${payload.content.trimEnd()}\n\n${browserCaptureFence}\n`,
    browserCaptureSpillPaths:
      browserCaptureSpillPaths.length > 0
        ? [...new Set(browserCaptureSpillPaths)]
        : undefined,
  };
}

/** Opens a popped queue item for editing; a deny note stays out of reconnect restores meanwhile. */
function startEdit(popped: QueuedMessage, originalIndex: number): ComposerQueueEdit {
  if (!popped.approvalNote) return { messageId: popped.id, originalIndex };
  setApprovalNoteInEdit(popped.approvalNote.requestId, true);
  return { messageId: popped.id, originalIndex, approvalNote: popped.approvalNote };
}

/**
 * Returns the edit being swapped out to its slot. An emptied edit leaves the queue, as it always
 * has; a deny note also leaves the server, so the next reconnect does not bring it back.
 */
function putBackSwappedEdit(
  threadId: string,
  editing: ComposerQueueEdit,
  payload: Omit<QueuedMessage, "id" | "queuedAt"> | null,
): void {
  const note = editing.approvalNote;
  if (payload) {
    useQueueStore.getState().insertAt(threadId, editing.originalIndex, note ? { ...payload, approvalNote: note } : payload);
    if (note) void saveApprovalNoteEdit(threadId, note.requestId, payload.content);
  } else if (note) {
    void discardApprovalNote(note.requestId);
  }
  if (note) setApprovalNoteInEdit(note.requestId, false);
}

/** Manages the pop, restore, swap, cancel, and completion lifecycle for one queued Composer message. */
export function useComposerQueueEditing({
  threadId,
  form,
  annotations,
}: UseComposerQueueEditingOptions): {
  editing: ComposerQueueEdit | null;
  loadIntoComposer: (message: QueuedMessage) => void;
  cancelEdit: () => void;
  discardEmptyEdit: () => boolean;
  finishEditing: () => void;
  consumeEditForDispatch: () => void;
  releaseConsumedEdit: () => void;
  resolvePreviewAnnotations: (
    currentPreviewAnnotations: PreviewAnnotationBundle | undefined,
  ) => PreviewAnnotationBundle | undefined;
  markRestoredPreviewAnnotationsCleared: () => void;
} {
  const [editing, setEditing] = useState<ComposerQueueEdit | null>(null);
  const originalMessageRef = useRef<QueuedMessage | null>(null);
  const restoredPreviewAnnotationsClearedRef = useRef(false);
  // While a direct dispatch owns the edit's content, cancel/discard must not
  // reinsert the popped original — it would resend as a ghost queue entry.
  const editConsumedByDispatchRef = useRef(false);

  const finishEditing = useCallback(() => {
    const noteRequestId = originalMessageRef.current?.approvalNote?.requestId;
    if (noteRequestId) setApprovalNoteInEdit(noteRequestId, false);
    editConsumedByDispatchRef.current = false;
    originalMessageRef.current = null;
    restoredPreviewAnnotationsClearedRef.current = false;
    setEditing(null);
    useQueueStore.getState().setEditingThreadId(null);
  }, []);

  const consumeEditForDispatch = useCallback(() => {
    if (editing) editConsumedByDispatchRef.current = true;
  }, [editing]);

  const releaseConsumedEdit = useCallback(() => {
    editConsumedByDispatchRef.current = false;
  }, []);

  const resolvePreviewAnnotations = useCallback(
    (currentPreviewAnnotations: PreviewAnnotationBundle | undefined) =>
      currentPreviewAnnotations ??
      (editing && !restoredPreviewAnnotationsClearedRef.current
        ? originalMessageRef.current?.previewAnnotations
        : undefined),
    [editing],
  );

  const markRestoredPreviewAnnotationsCleared = useCallback(() => {
    if (editing && originalMessageRef.current?.previewAnnotations) {
      restoredPreviewAnnotationsClearedRef.current = true;
    }
  }, [editing]);

  const captureEdit = useCallback(() => {
    const restoredPreviewAnnotations = restoredPreviewAnnotationsClearedRef.current
      ? undefined
      : originalMessageRef.current?.previewAnnotations;
    return preserveBrowserCapturePayload(form.capture(restoredPreviewAnnotations), originalMessageRef.current);
  }, [form]);

  const loadIntoComposer = useCallback(
    (message: QueuedMessage) => {
      if (!threadId || editConsumedByDispatchRef.current) return;

      const queue = useQueueStore.getState();
      const targetIndex = (queue.queues[threadId] ?? []).findIndex(
        (queued) => queued.id === message.id,
      );
      if (targetIndex === -1) return;

      form.invalidateAttachments();
      if (editing) putBackSwappedEdit(threadId, editing, form.hasContent() ? captureEdit() : null);

      const popped = queue.popMessage(threadId, message.id);
      if (!popped) return;

      originalMessageRef.current = popped;
      restoredPreviewAnnotationsClearedRef.current = false;
      setEditing(startEdit(popped, targetIndex));
      queue.setEditingThreadId(threadId);

      form.restore(popped);
      annotations.restore(popped.previewAnnotations);
    },
    [annotations, captureEdit, editing, form, threadId],
  );

  const cancelEdit = useCallback(() => {
    if (!threadId || !editing || editConsumedByDispatchRef.current) return;

    form.invalidateAttachments();
    const original = originalMessageRef.current;
    if (original) {
      useQueueStore.getState().insertAt(threadId, editing.originalIndex, toQueuePayload(original));
    }
    finishEditing();
    annotations.clear();
    scheduleDrainAfterEdit(threadId);
    form.clear();
  }, [annotations, editing, finishEditing, form, threadId]);

  const discardEmptyEdit = useCallback((): boolean => {
    if (!threadId || !editing || editConsumedByDispatchRef.current) return false;

    const slot = editing.originalIndex;
    const browserCaptureSpillPaths = originalMessageRef.current?.browserCaptureSpillPaths ?? [];
    if (editing.approvalNote) void discardApprovalNote(editing.approvalNote.requestId);
    finishEditing();
    annotations.clear();
    scheduleDrainAfterEdit(threadId);
    void releaseBrowserCaptureSpills(browserCaptureSpillPaths);
    useToastStore
      .getState()
      .show({
        kind: "info",
        title: "Removed from queue",
        meta: `Slot ${String(slot + 1).padStart(2, "0")}`,
      });
    return true;
  }, [annotations, editing, finishEditing, threadId]);

  return {
    editing,
    loadIntoComposer,
    cancelEdit,
    discardEmptyEdit,
    finishEditing,
    consumeEditForDispatch,
    releaseConsumedEdit,
    resolvePreviewAnnotations,
    markRestoredPreviewAnnotationsCleared,
  };
}
