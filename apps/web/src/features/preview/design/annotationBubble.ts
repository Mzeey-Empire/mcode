/**
 * Owns annotation bubble geometry, draft conversion and local edit state, shared by design rendering and its ordered lifecycle hooks.
 */
import { useCallback, useState, type CSSProperties } from "react";
import type { McodeBrowserCaptureV2 } from "@mcode/contracts/models/browser-preview";
import { cn } from "@/lib/utils";
import type { PreviewDraftAnnotation, SavedPreviewAnnotation } from "../state/previewAnnotationStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import type { PreviewPageScroll } from "../state/previewPageScrollStore";

const ANNOTATION_BUBBLE_WIDTH_PX = 290;

const ANNOTATION_BUBBLE_MARGIN_PX = 8;

/** Room the bubble needs below its element before it flips above; the note editor is about this tall. */
const ANNOTATION_BUBBLE_FLIP_HEIGHT_PX = 220;

// Opaque role surfaces keep annotations legible over arbitrary user page content in both themes.
/** Primary note bubble surface. */
export const BUBBLE_SURFACE = "var(--panel)";

/** Inset/footer surface inside the bubble. */
export const BUBBLE_SURFACE_INSET = "var(--selected)";

const ANNOTATION_BUBBLE_KEEP_OPEN_SELECTORS = [
  "[data-preview-design-keep-open]",
  "[data-slash-tray]",
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

/**
 * Moves viewport bounds captured at one scroll offset to where the page shows them at another.
 */
export function boundsAtScroll(
  bounds: PreviewDraftAnnotation["bounds"],
  capturedAt: McodeBrowserCaptureV2["viewportScroll"],
  current: PreviewPageScroll,
): PreviewDraftAnnotation["bounds"] {
  return {
    ...bounds,
    x: bounds.x + (capturedAt?.scrollX ?? 0) - current.x,
    y: bounds.y + (capturedAt?.scrollY ?? 0) - current.y,
  };
}

/**
 * Places the note bubble under its element, kept inside the preview width. It flips above the
 * element when there is too little room below and more room above.
 */
export function annotationBubbleStyle(
  bounds: PreviewDraftAnnotation["bounds"],
  surfaceWidth: number,
  surfaceHeight: number,
): CSSProperties {
  const maxLeft =
    surfaceWidth > 0
      ? Math.max(ANNOTATION_BUBBLE_MARGIN_PX, surfaceWidth - ANNOTATION_BUBBLE_WIDTH_PX - ANNOTATION_BUBBLE_MARGIN_PX)
      : bounds.x;
  const left = Math.min(Math.max(ANNOTATION_BUBBLE_MARGIN_PX, bounds.x), maxLeft);
  const below = Math.max(ANNOTATION_BUBBLE_MARGIN_PX, bounds.y + bounds.height + ANNOTATION_BUBBLE_MARGIN_PX);
  const roomBelow = surfaceHeight - below;
  const roomAbove = bounds.y - ANNOTATION_BUBBLE_MARGIN_PX;
  const flipsAbove =
    surfaceHeight > 0 && roomBelow < ANNOTATION_BUBBLE_FLIP_HEIGHT_PX && roomAbove > roomBelow;
  if (flipsAbove) {
    return { width: ANNOTATION_BUBBLE_WIDTH_PX, left, bottom: surfaceHeight - bounds.y + ANNOTATION_BUBBLE_MARGIN_PX };
  }
  return { width: ANNOTATION_BUBBLE_WIDTH_PX, left, top: below };
}

function draftFromSaved(
  threadId: string,
  annotation: SavedPreviewAnnotation,
): PreviewDraftAnnotation {
  return {
    threadId,
    pageIdentity: annotation.pageIdentity,
    bounds: boundsAtScroll(annotation.targetContext.bounds, undefined, {
      x: annotation.pageContext.viewportScroll?.scrollX ?? 0,
      y: annotation.pageContext.viewportScroll?.scrollY ?? 0,
    }),
    selectorHint: annotation.targetContext.selectorHint,
    label: annotation.targetContext.label,
    pageContext: annotation.pageContext,
    note: annotation.note ?? "",
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

/** Allows saving an open annotation only when it has note text. */
export function canSaveAnnotation(
  annotation: PreviewDraftAnnotation | undefined,
  note: string,
): boolean {
  return annotation !== undefined && note.trim().length > 0;
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
  readonly outsideWarned: boolean;
}

function newAnnotationBubbleEditorState(
  draftAnnotation: PreviewDraftAnnotation | undefined,
  editingSavedAnnotation: SavedPreviewAnnotation | undefined,
): AnnotationBubbleEditorState {
  const source = draftAnnotation ?? editingSavedAnnotation;
  return {
    source,
    note: source?.note ?? "",
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
  const setOutsideWarned = useCallback(
    (outsideWarned: boolean): void => update((state) => ({ ...state, outsideWarned })),
    [update],
  );

  return {
    bubbleNote: current.note,
    setBubbleNote,
    outsideWarned: current.outsideWarned,
    setOutsideWarned,
  };
}

/** Hides annotation markers and the bubble while design mode is inactive. */
export function visibleAnnotationState(
  designModeActive: boolean,
  openBubbleBase: PreviewDraftAnnotation | undefined,
  pageAnnotations: readonly SavedPreviewAnnotation[],
): {
  readonly openBubbleBase: PreviewDraftAnnotation | undefined;
  readonly pageAnnotations: readonly SavedPreviewAnnotation[];
} {
  const visibleOpenBubbleBase = designModeActive ? openBubbleBase : undefined;
  return {
    openBubbleBase: visibleOpenBubbleBase,
    pageAnnotations: designModeActive ? pageAnnotations : EMPTY_SAVED_ANNOTATIONS,
  };
}

/** Reads the available width used to position the annotation bubble. */
export function previewSurfaceWidth(surface: HTMLDivElement | null): number {
  return surface?.clientWidth ?? 0;
}

/** Reads the available height used to flip the annotation bubble above its element. */
export function previewSurfaceHeight(surface: HTMLDivElement | null): number {
  return surface?.clientHeight ?? 0;
}

/** Chooses the bubble border for its editing state. */
export function annotationBubbleClassName(
  outsideWarned: boolean,
  bubbleInputFocused: boolean,
): string {
  const focusClassName = outsideWarned
    ? "animate-preview-annotation-shake border-destructive/80"
    : bubbleInputFocused
      ? "border-focus ring-1 ring-focus"
      : "border-border ring-1 ring-border";
  return cn(
    "pointer-events-auto absolute z-(--layer-floating-panel) overflow-hidden rounded-[14px] border shadow-floating transition-[border-color,box-shadow] duration-150",
    focusClassName,
  );
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
