import { OVERVIEW_DOCK_MIN_CANVAS } from "@/lib/composer-layout";
import { useDiffStore } from "@/stores/diffStore";
import {
  newThreadOverviewKey,
  overviewPresentation,
  threadOverviewKey,
  useOverviewStore,
  type OverviewPresentation,
  type OverviewSubjectKey,
} from "@/stores/overviewStore";

/** A canvas docks the card only with the right panel closed and room left for the composer. */
export function canDockOverview(rightPanelVisible: boolean, canvasWidth: number): boolean {
  return !rightPanelVisible && canvasWidth >= OVERVIEW_DOCK_MIN_CANVAS;
}

/**
 * Where one Overview lives: its store key, and the right panel scope whose visibility decides
 * whether the card can dock. A new thread's panel scope has no thread id.
 */
export interface OverviewScope {
  readonly key: OverviewSubjectKey;
  readonly workspaceId: string;
  readonly threadId: string | null;
}

/** The Overview scope of a persisted thread. */
export function threadOverviewScope(thread: { id: string; workspace_id: string }): OverviewScope {
  return { key: threadOverviewKey(thread.id), workspaceId: thread.workspace_id, threadId: thread.id };
}

/** The Overview scope of a workspace's new thread. */
export function newThreadOverviewScope(workspaceId: string): OverviewScope {
  return { key: newThreadOverviewKey(workspaceId), workspaceId, threadId: null };
}

/** The resolved Overview state for one chat canvas. */
export interface OverviewPresentationState {
  dockable: boolean;
  presentation: OverviewPresentation;
}

/**
 * Resolves how an Overview shows on a chat canvas of the given width. The header button and the
 * canvas padding both read this, so they agree on whether the card is docked.
 */
export function useOverviewPresentation(scope: OverviewScope | null, canvasWidth: number): OverviewPresentationState {
  const key = scope?.key ?? null;
  const rightPanelVisible = useDiffStore((s) =>
    scope ? s.getRightPanelVisible(scope.workspaceId, scope.threadId) : false,
  );
  const closed = useOverviewStore((s) => key !== null && s.closedSubjects.has(key));
  const overlay = useOverviewStore((s) => key !== null && s.overlaySubject === key);
  if (!key) return { dockable: false, presentation: "hidden" };
  const dockable = canDockOverview(rightPanelVisible, canvasWidth);
  return { dockable, presentation: overviewPresentation({ closed, overlay, dockable }) };
}
