import { useCallback, useMemo } from "react";
import type { PreviewAnnotationBundle } from "@mcode/contracts";
import type { QueuedMessage } from "@/stores/queueStore";
import type { ComposerFormController } from "../draft/useComposerFormController";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";
import { useComposerQueueEditing } from "../queue/useComposerQueueEditing";
import { useQueuedMessageDispatch } from "../queue/useQueuedMessageDispatch";
import { createQueuedComposerPayload } from "../queue/createQueuedComposerPayload";
import {
  buildComposerAnnotationBundle,
  clearComposerAnnotations,
  restoreComposerAnnotations,
} from "./composer-annotations";
import { settlePageSnapshots } from "./prepare-composer-submission";

/** Inputs that connect one Composer form to all queue lifecycles. */
export interface UseComposerQueueControllerOptions {
  threadId?: string;
  annotationScopeId?: string;
  form: ComposerFormController;
}

/** Owns queue editing and explicit queued-message dispatch for one Composer. */
export function useComposerQueueController({
  threadId,
  annotationScopeId,
  form,
}: UseComposerQueueControllerOptions) {
  const setPreviewDesignModeActive = usePreviewDesignModeStore((state) => state.setActive);
  const clearAnnotations = useCallback(() => {
    if (!annotationScopeId) return;
    clearComposerAnnotations(annotationScopeId);
    setPreviewDesignModeActive(annotationScopeId, false);
  }, [annotationScopeId, setPreviewDesignModeActive]);
  const restoreAnnotations = useCallback(
    (message: QueuedMessage) => {
      if (!annotationScopeId) return;
      const restored = restoreComposerAnnotations(annotationScopeId, message);
      setPreviewDesignModeActive(annotationScopeId, restored && Boolean(message.previewAnnotations?.annotations.length));
    },
    [annotationScopeId, setPreviewDesignModeActive],
  );
  const formForQueueEdit = useMemo(
    () => ({
      hasContent: () => form.state.hasContent,
      capture: (restoredPreviewAnnotations: PreviewAnnotationBundle | undefined) =>
        createQueuedComposerPayload({
          attachments: form.state.attachments,
          input: form.state.text,
          mentions: form.state.mentions,
          previewAnnotations:
            buildComposerAnnotationBundle(annotationScopeId) ?? restoredPreviewAnnotations,
          selection: form.state.selection,
          goalPending: form.state.goalPending,
        }),
      restore: form.restoreQueued,
      clear: () => {
        form.clear("queue-cancel");
      },
      invalidateAttachments: form.attachmentBindings.invalidatePreparation,
    }),
    [annotationScopeId, form],
  );
  const annotationsForQueueEdit = useMemo(
    () => ({
      restore: restoreAnnotations,
      clear: clearAnnotations,
      settle: async () =>
        !annotationScopeId || await settlePageSnapshots(annotationScopeId, "Could not switch queued message"),
    }),
    [annotationScopeId, clearAnnotations, restoreAnnotations],
  );
  const editing = useComposerQueueEditing({
    threadId,
    form: formForQueueEdit,
    annotations: annotationsForQueueEdit,
  });
  const dispatch = useQueuedMessageDispatch(threadId);

  return {
    ...editing,
    sendQueuedMessageNow: dispatch.sendNow,
    clearAnnotations,
  };
}
