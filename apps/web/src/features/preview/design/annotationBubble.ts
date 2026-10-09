/**
 * Owns annotation bubble geometry, draft conversion and local edit state, shared by design rendering and its ordered lifecycle hooks.
 */
import { useCallback, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import type { PreviewAnnotationVisualProposal } from "@mcode/contracts";
import type { PreviewAnnotationSnapshotRequest } from "@/transport/desktop-bridge";
import { cn } from "@/lib/utils";
import type { PreviewDraftAnnotation, SavedPreviewAnnotation } from "../state/previewAnnotationStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import {
  visualProposalBounds,
  cleanVisualProposal,
  hasVisualProposal,
  initialVisualControls,
} from "./visualProposalModel";

const ANNOTATION_BUBBLE_MAX_WIDTH_PX = 336;

const ANNOTATION_BUBBLE_MARGIN_PX = 8;

// Opaque role surfaces keep annotations legible over arbitrary user page content in both themes.
/** Primary bubble surface used on the main row and the inspector panel. */
export const BUBBLE_SURFACE = "var(--panel)";

/** Inset/footer surface inside the bubble. */
export const BUBBLE_SURFACE_INSET = "var(--selected)";

const ANNOTATION_BUBBLE_KEEP_OPEN_SELECTORS = [
  "[data-preview-design-keep-open]",
  "[data-slash-popup]",
  "[data-file-popup]",
  "[data-file-item]",
] as const;

/** Recognizes the bubble and its external popups as one editing interaction. */
export function isAnnotationBubbleInteractionTarget(
  target: EventTarget | null,
  bubble: HTMLDivElement | null,
): boolean {
  if (!(target instanceof Node)) return false;
  if (bubble?.contains(target)) return true;
  return target instanceof Element &&
    ANNOTATION_BUBBLE_KEEP_OPEN_SELECTORS.some((selector) => target.closest(selector));
}

/** Positions the note bubble within the available preview width. */
export function annotationBubbleStyle(
  bounds: PreviewDraftAnnotation["bounds"],
  surfaceWidth: number,
): CSSProperties {
  const bubbleWidth =
    surfaceWidth > 0
      ? Math.min(
          ANNOTATION_BUBBLE_MAX_WIDTH_PX,
          Math.max(0, surfaceWidth - ANNOTATION_BUBBLE_MARGIN_PX * 2),
        )
      : ANNOTATION_BUBBLE_MAX_WIDTH_PX;
  const preferredLeft = bounds.x + bounds.width + ANNOTATION_BUBBLE_MARGIN_PX;
  const maxLeft =
    surfaceWidth > 0
      ? Math.max(
          ANNOTATION_BUBBLE_MARGIN_PX,
          surfaceWidth - bubbleWidth - ANNOTATION_BUBBLE_MARGIN_PX,
        )
      : preferredLeft;

  return {
    left: Math.min(
      Math.max(ANNOTATION_BUBBLE_MARGIN_PX, preferredLeft),
      maxLeft,
    ),
    top: Math.max(ANNOTATION_BUBBLE_MARGIN_PX, bounds.y),
    maxWidth: `calc(100% - ${ANNOTATION_BUBBLE_MARGIN_PX * 2}px)`,
  };
}

function draftFromSaved(
  threadId: string,
  annotation: SavedPreviewAnnotation,
): PreviewDraftAnnotation {
  const elementStyle =
    annotation.pageContext.elementStyle ?? annotation.snapshot.capture.elementStyle;
  return {
    threadId,
    pageIdentity: annotation.pageIdentity,
    bounds: annotation.targetContext.bounds,
    selectorHint: annotation.targetContext.selectorHint,
    label: annotation.targetContext.label,
    snapshot: annotation.snapshot,
    pageContext: annotation.pageContext,
    ...(elementStyle ? { elementStyle } : {}),
    note: annotation.note ?? "",
    proposedChanges: annotation.proposedChanges,
  };
}

/** Builds the existing capture request for a draft or saved annotation. */
export function annotationSnapshotRequest(
  pageAnnotations: readonly SavedPreviewAnnotation[],
  savedAnnotationCount: number,
  editingAnnotation: SavedPreviewAnnotation | undefined,
  annotation: PreviewDraftAnnotation,
  proposedChanges: PreviewAnnotationVisualProposal | undefined,
): PreviewAnnotationSnapshotRequest {
  const markerByDisplayNumber = new Map<
    number,
    PreviewAnnotationSnapshotRequest["markers"][number]
  >();
  for (const savedAnnotation of pageAnnotations) {
    markerByDisplayNumber.set(savedAnnotation.displayNumber, {
      displayNumber: savedAnnotation.displayNumber,
      bounds: savedAnnotation.targetContext.bounds,
    });
  }
  const activeDisplayNumber =
    editingAnnotation?.displayNumber ?? savedAnnotationCount + 1;
  markerByDisplayNumber.set(activeDisplayNumber, {
    displayNumber: activeDisplayNumber,
    bounds: annotation.bounds,
  });
  return {
    activeDisplayNumber,
    activeBounds: visualProposalBounds(
      annotation.bounds,
      proposedChanges,
      annotation.elementStyle,
    ),
    markers: Array.from(markerByDisplayNumber.values()),
  };
}

/** Finds the saved annotation currently selected for editing. */
export function savedAnnotationById(
  annotations: readonly SavedPreviewAnnotation[],
  annotationId: string | null,
): SavedPreviewAnnotation | undefined {
  if (!annotationId) return undefined;
  return annotations.find((annotation) => annotation.id === annotationId);
}

/** Uses the active draft or converts the selected saved annotation for editing. */
export function openAnnotationBase(
  threadId: string,
  draftAnnotation: PreviewDraftAnnotation | undefined,
  savedAnnotation: SavedPreviewAnnotation | undefined,
): PreviewDraftAnnotation | undefined {
  if (draftAnnotation) return draftAnnotation;
  return savedAnnotation ? draftFromSaved(threadId, savedAnnotation) : undefined;
}

/** Cleans visual edits against the open annotation element style. */
export function annotationProposedChanges(
  annotation: PreviewDraftAnnotation | undefined,
  bubbleVisuals: PreviewAnnotationVisualProposal,
): PreviewAnnotationVisualProposal | undefined {
  if (!annotation) return undefined;
  return cleanVisualProposal(bubbleVisuals, annotation.elementStyle);
}

/** Allows saving an open annotation with note text or a visual proposal. */
export function canSaveAnnotation(
  annotation: PreviewDraftAnnotation | undefined,
  note: string,
  proposedChanges: PreviewAnnotationVisualProposal | undefined,
): boolean {
  return annotation !== undefined &&
    (note.trim().length > 0 || hasVisualProposal(proposedChanges));
}

/** Identifies the draft or saved annotation that should receive input focus. */
export function annotationFocusKey(
  draftAnnotation: PreviewDraftAnnotation | undefined,
  editingAnnotationId: string | null,
): string | null {
  if (draftAnnotation) {
    const { pageIdentity, bounds } = draftAnnotation;
    return `draft:${pageIdentity}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
  }
  return editingAnnotationId ? `edit:${editingAnnotationId}` : null;
}

type AnnotationBubbleSource = PreviewDraftAnnotation | SavedPreviewAnnotation | undefined;

interface AnnotationBubbleEditorState {
  readonly source: AnnotationBubbleSource;
  readonly note: string;
  readonly visuals: PreviewAnnotationVisualProposal;
  readonly advancedOpen: boolean;
  readonly outsideWarned: boolean;
}

function newAnnotationBubbleEditorState(
  draftAnnotation: PreviewDraftAnnotation | undefined,
  editingSavedAnnotation: SavedPreviewAnnotation | undefined,
): AnnotationBubbleEditorState {
  if (draftAnnotation) {
    return {
      source: draftAnnotation,
      note: draftAnnotation.note,
      visuals: initialVisualControls(
        draftAnnotation.elementStyle,
        draftAnnotation.proposedChanges,
      ),
      advancedOpen: false,
      outsideWarned: false,
    };
  }
  if (editingSavedAnnotation) {
    const elementStyle =
      editingSavedAnnotation.pageContext.elementStyle ??
      editingSavedAnnotation.snapshot.capture.elementStyle;
    return {
      source: editingSavedAnnotation,
      note: editingSavedAnnotation.note ?? "",
      visuals: initialVisualControls(
        elementStyle,
        editingSavedAnnotation.proposedChanges,
      ),
      advancedOpen: false,
      outsideWarned: false,
    };
  }
  return {
    source: undefined,
    note: "",
    visuals: {},
    advancedOpen: false,
    outsideWarned: false,
  };
}

/** Keeps annotation edits local until the draft or saved annotation changes. */
export function useAnnotationBubbleEditor(
  draftAnnotation: PreviewDraftAnnotation | undefined,
  editingSavedAnnotation: SavedPreviewAnnotation | undefined,
): {
  readonly bubbleNote: string;
  readonly setBubbleNote: (note: string) => void;
  readonly bubbleVisuals: PreviewAnnotationVisualProposal;
  readonly setBubbleVisuals: Dispatch<SetStateAction<PreviewAnnotationVisualProposal>>;
  readonly bubbleAdvancedOpen: boolean;
  readonly setBubbleAdvancedOpen: Dispatch<SetStateAction<boolean>>;
  readonly outsideWarned: boolean;
  readonly setOutsideWarned: (outsideWarned: boolean) => void;
} {
  const [state, setState] = useState(() =>
    newAnnotationBubbleEditorState(draftAnnotation, editingSavedAnnotation),
  );
  const source = draftAnnotation ?? editingSavedAnnotation;
  const current = state.source === source
    ? state
    : newAnnotationBubbleEditorState(draftAnnotation, editingSavedAnnotation);
  const update = useCallback(
    (updateState: (current: AnnotationBubbleEditorState) => AnnotationBubbleEditorState): void => {
      setState((state) => updateState(
        state.source === source
          ? state
          : newAnnotationBubbleEditorState(draftAnnotation, editingSavedAnnotation),
      ));
    },
    [draftAnnotation, editingSavedAnnotation, source],
  );
  const setBubbleNote = useCallback(
    (note: string): void => update((state) => ({ ...state, note })),
    [update],
  );
  const setBubbleVisuals = useCallback(
    (visuals: SetStateAction<PreviewAnnotationVisualProposal>): void => {
      update((state) => ({
        ...state,
        visuals: typeof visuals === "function"
          ? visuals(state.visuals)
          : visuals,
      }));
    },
    [update],
  );
  const setBubbleAdvancedOpen = useCallback(
    (advancedOpen: SetStateAction<boolean>): void => {
      update((state) => ({
        ...state,
        advancedOpen: typeof advancedOpen === "function"
          ? advancedOpen(state.advancedOpen)
          : advancedOpen,
      }));
    },
    [update],
  );
  const setOutsideWarned = useCallback(
    (outsideWarned: boolean): void => update((state) => ({ ...state, outsideWarned })),
    [update],
  );

  return {
    bubbleNote: current.note,
    setBubbleNote,
    bubbleVisuals: current.visuals,
    setBubbleVisuals,
    bubbleAdvancedOpen: current.advancedOpen,
    setBubbleAdvancedOpen,
    outsideWarned: current.outsideWarned,
    setOutsideWarned,
  };
}

/** Chooses the existing page label for the annotation header. */
export function annotationPageLabel(
  pageIdentity: string,
  inputUrl: string,
): string {
  return pageIdentity || inputUrl || "current page";
}

/** Hides annotation markers and proposals while design mode is inactive. */
export function visibleAnnotationState(
  designModeActive: boolean,
  openBubbleBase: PreviewDraftAnnotation | undefined,
  pageAnnotations: readonly SavedPreviewAnnotation[],
  bubbleVisuals: PreviewAnnotationVisualProposal,
): {
  readonly openBubbleBase: PreviewDraftAnnotation | undefined;
  readonly pageAnnotations: readonly SavedPreviewAnnotation[];
  readonly visualProposal: PreviewAnnotationVisualProposal | undefined;
} {
  const visibleOpenBubbleBase = designModeActive ? openBubbleBase : undefined;
  return {
    openBubbleBase: visibleOpenBubbleBase,
    pageAnnotations: designModeActive ? pageAnnotations : EMPTY_SAVED_ANNOTATIONS,
    visualProposal: annotationProposedChanges(visibleOpenBubbleBase, bubbleVisuals),
  };
}

/** Reads the available width used to position the annotation bubble. */
export function previewSurfaceWidth(surface: HTMLDivElement | null): number {
  return surface?.clientWidth ?? 0;
}

/** Shows the annotation header while design mode has saved annotations. */
export function shouldShowAnnotationCommandBar(
  designModeActive: boolean,
  annotationCount: number,
): boolean {
  return designModeActive && annotationCount > 0;
}

/** Chooses the existing bubble border and size for its editing state. */
export function annotationBubbleClassName(
  outsideWarned: boolean,
  bubbleInputFocused: boolean,
  bubbleAdvancedOpen: boolean,
): string {
  const focusClassName = outsideWarned
    ? "animate-preview-annotation-shake border-destructive/80"
    : bubbleInputFocused
      ? "border-focus ring-1 ring-focus"
      : "border-border ring-1 ring-border";
  return cn(
    "pointer-events-auto absolute z-(--layer-floating-panel) w-[min(20.5rem,calc(100%-1rem))] overflow-hidden rounded-[1.55rem] border shadow-floating transition-[border-color,box-shadow] duration-150",
    focusClassName,
    bubbleAdvancedOpen ? "max-h-[20.5rem]" : "min-h-11",
  );
}

/** Chooses the captured element label displayed in the inspector. */
export function annotationBubbleTargetLabel(annotation: PreviewDraftAnnotation): string {
  return annotation.label?.trim() || annotation.selectorHint?.trim() || "Element";
}

/** Resolves the provider used by annotation autocomplete. */
export function activeThreadProviderId(
  thread: WorkspaceThread | undefined,
): string | undefined {
  return thread?.provider ?? undefined;
}

/** Converts an absent workspace to the autocomplete hooks optional argument. */
export function optionalWorkspaceId(
  workspaceId: string | null | undefined,
): string | undefined {
  return workspaceId ?? undefined;
}

/** Provides the stable empty annotation list used by selectors and visibility filtering. */
export const EMPTY_SAVED_ANNOTATIONS: SavedPreviewAnnotation[] = [];
