import { useCallback, useRef, useState } from "react";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { releaseBrowserCaptureSpills } from "@/features/preview/capture/browser-capture-spill";
import {
  MCODE_BROWSER_CAPTURE_FENCE_CLOSE,
  MCODE_BROWSER_CAPTURE_FENCE_OPEN,
} from "@/features/preview/capture/browser-capture-append";
import { useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { scheduleDrainAfterEdit } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { dropDraftContentInBundleWhenSettled, readDraftContentInBundle } from "./queued-draft-bundle";
import { queueHoldingDraftElements } from "./queued-draft-holds";

/** The queue slot currently restored into the Composer for editing. */
export interface ComposerQueueEdit {
  messageId: string;
  originalIndex: number;
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
  /** Shows the comments and notes of a message just taken out of the queue for editing. */
  restore: (message: QueuedMessage) => void;
  clear: () => void;
  /** Finishes pending page snapshot redraws. Resolves false, after telling the user, when one fails. */
  settle: () => Promise<boolean>;
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

/**
 * The bundle an edit falls back to when the Composer shows no annotations. A message that held
 * its draft elements returned them to the draft, so the draft alone says what it still carries.
 */
function fallbackPreviewAnnotations(original: QueuedMessage | null): PreviewAnnotationBundle | undefined {
  return original?.holdsDraftElements ? undefined : original?.previewAnnotations;
}

/**
 * Re-queues a message and holds the draft elements its bundle carries under the new entry.
 * When the user deleted some of them during the edit, the draft cannot hold the whole bundle,
 * so the entry goes back without a hold and keeps the bundle, as a queued message always did.
 */
function requeueHoldingDraft(
  threadId: string,
  index: number,
  payload: Omit<QueuedMessage, "id" | "queuedAt">,
): boolean {
  const content = readDraftContentInBundle(threadId, payload.previewAnnotations);
  const held = content.diffComments.length
    + content.fileComments.length
    + content.browserNotePages.reduce((total, page) => total + page.notes.length, 0);
  const complete = held === (payload.previewAnnotations?.annotations.length ?? 0);
  if (!complete) dropDraftContentInBundleWhenSettled(threadId, payload.previewAnnotations);
  return queueHoldingDraftElements(
    threadId,
    payload,
    complete ? content : { diffComments: [], fileComments: [], browserNotePages: [] },
    index,
  );
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
  const settlingRef = useRef(false);

  const finishEditing = useCallback(() => {
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
        ? fallbackPreviewAnnotations(originalMessageRef.current)
        : undefined),
    [editing],
  );

  const markRestoredPreviewAnnotationsCleared = useCallback(() => {
    if (editing && originalMessageRef.current?.previewAnnotations) {
      restoredPreviewAnnotationsClearedRef.current = true;
    }
  }, [editing]);

  const swapIntoComposer = useCallback(
    (message: QueuedMessage) => {
      if (!threadId) return;

      const queue = useQueueStore.getState();
      const targetIndex = (queue.queues[threadId] ?? []).findIndex(
        (queued) => queued.id === message.id,
      );
      if (targetIndex === -1) return;

      form.invalidateAttachments();
      if (editing && form.hasContent()) {
        const restoredPreviewAnnotations = restoredPreviewAnnotationsClearedRef.current
          ? undefined
          : fallbackPreviewAnnotations(originalMessageRef.current);
        requeueHoldingDraft(
          threadId,
          editing.originalIndex,
          preserveBrowserCapturePayload(
            form.capture(restoredPreviewAnnotations),
            originalMessageRef.current,
          ),
        );
      }

      // Clear first: popping a message that held its elements returns them to the draft at once.
      annotations.clear();
      const popped = queue.popMessage(threadId, message.id);
      if (!popped) return;

      originalMessageRef.current = popped;
      restoredPreviewAnnotationsClearedRef.current = false;
      setEditing({ messageId: popped.id, originalIndex: targetIndex });
      queue.setEditingThreadId(threadId);

      form.restore(popped);
      annotations.restore(popped);
    },
    [annotations, editing, form, threadId],
  );

  // Capturing the current edit reads each page's marked image, so a note edited a moment ago must
  // finish redrawing first or it would be re-queued without its page.
  const loadIntoComposer = useCallback(
    (message: QueuedMessage) => {
      if (!threadId || editConsumedByDispatchRef.current || settlingRef.current) return;
      if (!editing || !form.hasContent()) {
        swapIntoComposer(message);
        return;
      }
      const startedFrom = originalMessageRef.current;
      settlingRef.current = true;
      void annotations.settle().then((settled) => {
        settlingRef.current = false;
        const unchanged = originalMessageRef.current === startedFrom && !editConsumedByDispatchRef.current;
        if (settled && unchanged) swapIntoComposer(message);
      });
    },
    [annotations, editing, form, swapIntoComposer, threadId],
  );

  const cancelEdit = useCallback(() => {
    if (!threadId || !editing || editConsumedByDispatchRef.current) return;

    form.invalidateAttachments();
    const original = originalMessageRef.current;
    if (original) requeueHoldingDraft(threadId, editing.originalIndex, toQueuePayload(original));
    finishEditing();
    annotations.clear();
    scheduleDrainAfterEdit(threadId);
    form.clear();
  }, [annotations, editing, finishEditing, form, threadId]);

  const discardEmptyEdit = useCallback((): boolean => {
    if (!threadId || !editing || editConsumedByDispatchRef.current) return false;

    const slot = editing.originalIndex;
    const browserCaptureSpillPaths = originalMessageRef.current?.browserCaptureSpillPaths ?? [];
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
