/**
 * Derives the current page annotation and connects its draft editor to mention selection, separate from picker lifecycle effects.
 */
import { useCallback, useMemo } from "react";
import { normalizePreviewPageIdentity, usePreviewAnnotationStore } from "../state/previewAnnotationStore";
import { useFileTagPopup } from "@/components/chat/FileTagPopup";
import type { MentionSuggestion } from "@/components/chat/useFileAutocomplete";
import { type usePreviewPage, previewPageIdentityUrl } from "../surfaces/usePreviewPage";
import type { useDesignAnnotationState } from "./useDesignAnnotationState";
import {
  EMPTY_SAVED_ANNOTATIONS,
  savedAnnotationById,
  useAnnotationBubbleEditor,
  openAnnotationBase,
  annotationProposedChanges,
  canSaveAnnotation,
  annotationFocusKey,
  annotationPageLabel,
} from "./annotationBubble";

interface DesignAnnotationEditorOptions {
  readonly webviewPageStatus: ReturnType<typeof usePreviewPage>["webviewPageStatus"];
  readonly webviewInputUrl: ReturnType<typeof usePreviewPage>["webviewInputUrl"];
  readonly threadId: string;
  readonly annotationSignal: ReturnType<typeof useDesignAnnotationState>["annotationSignal"];
  readonly editingAnnotationId: ReturnType<typeof useDesignAnnotationState>["editingAnnotationId"];
  readonly draftAnnotation: ReturnType<typeof useDesignAnnotationState>["draftAnnotation"];
  readonly selectBubbleFileSuggestion: ReturnType<typeof useDesignAnnotationState>["selectBubbleFileSuggestion"];
  readonly bubbleNoteInputRef: ReturnType<typeof useDesignAnnotationState>["bubbleNoteInputRef"];
  readonly bubbleFileTriggerStart: ReturnType<typeof useDesignAnnotationState>["bubbleFileTriggerStart"];
  readonly bubbleFileSuggestions: ReturnType<typeof useDesignAnnotationState>["bubbleFileSuggestions"];
  readonly bubbleFileQuery: ReturnType<typeof useDesignAnnotationState>["bubbleFileQuery"];
  readonly bubbleFileOpen: ReturnType<typeof useDesignAnnotationState>["bubbleFileOpen"];
  readonly dismissBubbleFile: ReturnType<typeof useDesignAnnotationState>["dismissBubbleFile"];
}

/** Connects the current page annotation to its local editor and mention popup. */
export function useDesignAnnotationEditor({
  webviewPageStatus,
  webviewInputUrl,
  threadId,
  annotationSignal,
  editingAnnotationId,
  draftAnnotation,
  selectBubbleFileSuggestion,
  bubbleNoteInputRef,
  bubbleFileTriggerStart,
  bubbleFileSuggestions,
  bubbleFileQuery,
  bubbleFileOpen,
  dismissBubbleFile,
}: DesignAnnotationEditorOptions) {
  const currentPageIdentity = normalizePreviewPageIdentity(
    previewPageIdentityUrl(webviewPageStatus, webviewInputUrl),
  );
  const savedAnnotations = usePreviewAnnotationStore(
    (s) => s.byThread[threadId] ?? EMPTY_SAVED_ANNOTATIONS,
  );
  const pageAnnotations = useMemo(
    () =>
      savedAnnotations.filter(
        (annotation) => annotation.pageIdentity === currentPageIdentity,
      ),
    [savedAnnotations, currentPageIdentity],
  );
  const bundleCount = annotationSignal;
  const editingSavedAnnotation = savedAnnotationById(
    pageAnnotations,
    editingAnnotationId,
  );
  const {
    bubbleNote,
    setBubbleNote,
    bubbleVisuals,
    setBubbleVisuals,
    bubbleAdvancedOpen,
    setBubbleAdvancedOpen,
    outsideWarned,
    setOutsideWarned,
  } = useAnnotationBubbleEditor(draftAnnotation, editingSavedAnnotation);
  const handleBubbleMentionSelect = useCallback(
    (item: MentionSuggestion) => {
      selectBubbleFileSuggestion(item);
      const input = bubbleNoteInputRef.current;
      if (!input) return;
      const cursor = input.selectionStart ?? bubbleNote.length;
      const text = bubbleNote;
      // Insert `@<label> ` replacing the typed fragment from the @ trigger to
      // the cursor. This matches the text form Lexical serializes for MentionNode
      // (`@${label}`) so the agent-side parser sees identical content.
      const before = text.slice(0, bubbleFileTriggerStart);
      const after = text.slice(cursor);
      const inserted = `@${item.label} `;
      const next = before + inserted + after;
      // Enforce the maxLength cap before updating state.
      if (next.length <= 4000) {
        setBubbleNote(next);
        setOutsideWarned(false);
        // Restore cursor after state update (one frame later via rAF).
        const nextCursor = before.length + inserted.length;
        window.requestAnimationFrame(() => {
          if (!bubbleNoteInputRef.current) return;
          bubbleNoteInputRef.current.setSelectionRange(nextCursor, nextCursor);
        });
      }
    },
    [
      bubbleNoteInputRef,
      bubbleFileTriggerStart,
      bubbleNote,
      selectBubbleFileSuggestion,
      setBubbleNote,
      setOutsideWarned,
    ],
  );
  const bubbleFilePopup = useFileTagPopup({
    items: bubbleFileSuggestions,
    query: bubbleFileQuery,
    isOpen: bubbleFileOpen,
    onSelect: handleBubbleMentionSelect,
    onDismiss: dismissBubbleFile,
  });
  const openBubbleBase = openAnnotationBase(
    threadId,
    draftAnnotation,
    editingSavedAnnotation,
  );
  const openBubbleProposedChanges = annotationProposedChanges(
    openBubbleBase,
    bubbleVisuals,
  );
  const canSaveOpenBubble = canSaveAnnotation(
    openBubbleBase,
    bubbleNote,
    openBubbleProposedChanges,
  );
  const hasOpenBubble = Boolean(openBubbleBase);
  const openBubbleFocusKey = annotationFocusKey(
    draftAnnotation,
    editingAnnotationId,
  );
  const annotationHeaderPageLabel = annotationPageLabel(
    currentPageIdentity,
    webviewInputUrl,
  );

  return {
    openBubbleFocusKey,
    hasOpenBubble,
    setBubbleAdvancedOpen,
    setOutsideWarned,
    openBubbleBase,
    canSaveOpenBubble,
    outsideWarned,
    setBubbleVisuals,
    bubbleVisuals,
    bubbleNote,
    pageAnnotations,
    savedAnnotations,
    editingSavedAnnotation,
    setBubbleNote,
    bubbleFilePopup,
    bundleCount,
    annotationHeaderPageLabel,
    currentPageIdentity,
    bubbleAdvancedOpen,
    handleBubbleMentionSelect,
  };
}
