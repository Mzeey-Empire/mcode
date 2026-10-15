import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import { usePreviewDesignModeStore } from "@/features/preview/state/previewDesignModeStore";

/** Annotation lifecycle operations around a single immediate Composer dispatch. */
export interface ComposerAnnotationDispatchGuard {
  clearBeforeDispatch(): void;
  restoreAfterFailure(): void;
  stopWatching(): void;
}

/**
 * Preserves Browser annotations when transport fails unless the user changed
 * them meanwhile. Review comments never leave the draft on dispatch; their
 * submission settles them instead.
 */
export function createComposerAnnotationDispatchGuard(
  annotationScopeId: string | undefined,
  annotations: PreviewAnnotationBundle | undefined,
): ComposerAnnotationDispatchGuard {
  if (!annotationScopeId || !annotations) return EMPTY_ANNOTATION_DISPATCH_GUARD;

  let clearedNotes: ClearedNotes | undefined;
  let annotationsChangedAfterClear = false;
  const stopWatching = usePreviewAnnotationStore.subscribe((state, previousState) => {
    if (clearedNotes && annotationsChanged(state, previousState, annotationScopeId)) {
      annotationsChangedAfterClear = true;
    }
  });

  return {
    clearBeforeDispatch: () => {
      const store = usePreviewAnnotationStore.getState();
      const removed = {
        notes: store.byThread[annotationScopeId] ?? [],
        pages: store.pages[annotationScopeId] ?? {},
      };
      store.clearPreviewNotes(annotationScopeId);
      clearedNotes = removed;
      usePreviewDesignModeStore.getState().setActive(annotationScopeId, false);
    },
    restoreAfterFailure: () => {
      stopWatching();
      if (clearedNotes && !annotationsChangedAfterClear) {
        restoreAnnotations(annotationScopeId, annotations, clearedNotes);
      }
    },
    stopWatching,
  };
}

interface ClearedNotes {
  readonly notes: ReturnType<typeof usePreviewAnnotationStore.getState>["byThread"][string];
  readonly pages: ReturnType<typeof usePreviewAnnotationStore.getState>["pages"][string];
}

const EMPTY_ANNOTATION_DISPATCH_GUARD: ComposerAnnotationDispatchGuard = {
  clearBeforeDispatch: () => {},
  restoreAfterFailure: () => {},
  stopWatching: () => {},
};

/** Detects a user edit to the Browser annotations after the dispatch clear. */
function annotationsChanged(
  state: ReturnType<typeof usePreviewAnnotationStore.getState>,
  previousState: ReturnType<typeof usePreviewAnnotationStore.getState>,
  annotationScopeId: string,
): boolean {
  return state.byThread[annotationScopeId] !== previousState.byThread[annotationScopeId]
    || state.pages[annotationScopeId] !== previousState.pages[annotationScopeId];
}

function restoreAnnotations(
  annotationScopeId: string,
  annotations: PreviewAnnotationBundle,
  cleared: ClearedNotes,
): void {
  const store = usePreviewAnnotationStore.getState();
  const restored = cleared.notes.length > 0
    ? (store.reinstate(annotationScopeId, cleared.notes, cleared.pages), true)
    : store.restoreBundle(annotationScopeId, annotations);
  usePreviewDesignModeStore
    .getState()
    .setActive(annotationScopeId, restored && annotations.annotations.length > 0);
}
