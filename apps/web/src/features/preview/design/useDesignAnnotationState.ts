/**
 * Owns design selection and annotation autocomplete state. It runs before page subscriptions to preserve the original hook order.
 */
import { useEffect, useRef, useState } from "react";
import { usePreviewDesignModeStore } from "../state/previewDesignModeStore";
import { usePreviewAnnotationStore } from "../state/previewAnnotationStore";
import { useSlashCommand } from "@/components/chat/useSlashCommand";
import { useFileAutocomplete } from "@/components/chat/useFileAutocomplete";
import { useWorkspaceThread } from "@/features/projects/state/workspace-selectors";
import type {
  ExpandableVisualGroupId,
  VisualLinkPairId,
  ColorVisualProposalKey,
} from "./visualProposalModel";
import type { ColorFormat } from "./visualProposalColor";
import { activeThreadProviderId, optionalWorkspaceId } from "./annotationBubble";

interface DesignAnnotationStateOptions {
  readonly threadId: string;
  readonly workspaceId: string | null | undefined;
}

/** Keeps design selection and autocomplete hooks in their original declaration order. */
export function useDesignAnnotationState({
  threadId,
  workspaceId,
}: DesignAnnotationStateOptions) {
  const designModeActive = usePreviewDesignModeStore(
    (s) => s.modes[threadId] === true,
  );
  const designModeToggle = usePreviewDesignModeStore((s) => s.toggle);
  const designModeSetActive = usePreviewDesignModeStore((s) => s.setActive);
  const annotationSignal = usePreviewAnnotationStore(
    (s) => s.byThread[threadId]?.length ?? 0,
  );
  const draftAnnotation = usePreviewAnnotationStore((s) => s.drafts[threadId]);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(
    null,
  );
  const [expandedVisualGroups, setExpandedVisualGroups] = useState<
    Partial<Record<ExpandableVisualGroupId, boolean>>
  >({});
  const [linkedVisualPairs, setLinkedVisualPairs] = useState<
    Partial<Record<VisualLinkPairId, boolean>>
  >({});
  const [colorFormats, setColorFormats] = useState<
    Partial<Record<ColorVisualProposalKey, ColorFormat>>
  >({});
  // Tracks whether the note input inside the bubble has focus so we can show
  // a subtle ring on the bubble container itself instead of an inner ring on
  // the input (which would conflict with the dark background).
  const [bubbleInputFocused, setBubbleInputFocused] = useState(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleNoteInputRef = useRef<HTMLInputElement | null>(null);

  // Resolve provider + workspace path from the thread row so the autocomplete
  // hooks can load skills scoped to the same context as the Composer.
  const activeThread = useWorkspaceThread(threadId, (t) => t);
  const providerId = activeThreadProviderId(activeThread);
  // Slash-command autocomplete for the bubble. Builtins are excluded because
  // mcode app-level actions (plan, compact, goal) have no meaning inside an
  // annotation comment because they target the Composer's thread, not the bubble.
  const bubbleSlashCommand = useSlashCommand({
    anchorRef: bubbleNoteInputRef as React.RefObject<HTMLElement | null>,
    workspaceId: optionalWorkspaceId(workspaceId),
    threadId,
    providerId,
    includeBuiltins: false,
    includePlugins: false,
  });
  const {
    isOpen: bubbleSlashOpen,
    state: bubbleSlashState,
    items: bubbleSlashItems,
    selectedIndex: bubbleSlashSelectedIndex,
    anchorRect: bubbleSlashAnchorRect,
    onInputChange: onBubbleSlashInputChange,
    onKeyDown: onBubbleSlashKeyDown,
    onSelect: onBubbleSlashSelect,
    onDismiss: dismissBubbleSlash,
    onRetry: retryBubbleSlash,
  } = bubbleSlashCommand;

  // @ file/agent autocomplete for the bubble. Mirrors the Composer's setup;
  // agents only appear when the provider is codex (same gate as Composer).
  const bubbleFileAutocomplete = useFileAutocomplete({
    workspaceId: optionalWorkspaceId(workspaceId),
    threadId,
    providerId,
  });
  const {
    suggestions: bubbleFileSuggestions,
    query: bubbleFileQuery,
    isOpen: bubbleFileOpen,
    triggerStart: bubbleFileTriggerStart,
    handleInputChange: onBubbleFileInputChange,
    selectSuggestion: selectBubbleFileSuggestion,
    dismiss: dismissBubbleFile,
  } = bubbleFileAutocomplete;

  // Capture the anchor rect when the file popup opens rather than reading it
  // on every render. The bubble can shift (advanced panel expand, scroll) after
  // open, but the popup should stay pinned to where the input was when the
  // trigger fired, consistent with SlashCommandPopup's anchorRect behavior.
  const [filePopupAnchorRect, setFilePopupAnchorRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (bubbleFileOpen) {
      setFilePopupAnchorRect(bubbleNoteInputRef.current?.getBoundingClientRect() ?? null);
    } else {
      setFilePopupAnchorRect(null);
    }
  }, [bubbleFileOpen]);

  return {
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
    designModeActive,
    setEditingAnnotationId,
    dismissBubbleSlash,
    linkedVisualPairs,
    setLinkedVisualPairs,
    setColorFormats,
    bubbleRef,
    bubbleSlashOpen,
    designModeSetActive,
    designModeToggle,
    onBubbleSlashSelect,
    onBubbleSlashKeyDown,
    bubbleSlashItems,
    bubbleSlashSelectedIndex,
    bubbleInputFocused,
    onBubbleSlashInputChange,
    onBubbleFileInputChange,
    setBubbleInputFocused,
    colorFormats,
    expandedVisualGroups,
    setExpandedVisualGroups,
    bubbleSlashState,
    bubbleSlashAnchorRect,
    retryBubbleSlash,
    filePopupAnchorRect,
  };
}
