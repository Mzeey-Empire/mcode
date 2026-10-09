import { OVERVIEW_DOCK_MIN_CANVAS } from "@/lib/composer-layout";
import { useDiffStore } from "@/stores/diffStore";
import {
  overviewPresentation,
  threadOverviewKey,
  useOverviewStore,
  type OverviewPresentation,
} from "@/stores/overviewStore";

/** A canvas docks the card only with the right panel closed and room left for the composer. */
export function canDockOverview(rightPanelVisible: boolean, canvasWidth: number): boolean {
  return !rightPanelVisible && canvasWidth >= OVERVIEW_DOCK_MIN_CANVAS;
}

/** The resolved Overview state for one thread's chat canvas. */
export interface OverviewPresentationState {
  dockable: boolean;
  presentation: OverviewPresentation;
}

/**
 * Resolves how a thread's Overview shows on a chat canvas of the given width. The header button
 * and the conversation padding both read this, so they agree on whether the card is docked.
 */
export function useOverviewPresentation(
  thread: { id: string; workspace_id: string } | null,
  canvasWidth: number,
): OverviewPresentationState {
  const key = thread ? threadOverviewKey(thread.id) : null;
  const rightPanelVisible = useDiffStore((s) =>
    thread ? s.getRightPanelVisible(thread.workspace_id, thread.id) : false,
  );
  const closed = useOverviewStore((s) => key !== null && s.closedSubjects.has(key));
  const overlay = useOverviewStore((s) => key !== null && s.overlaySubject === key);
  if (!key) return { dockable: false, presentation: "hidden" };
  const dockable = canDockOverview(rightPanelVisible, canvasWidth);
  return { dockable, presentation: overviewPresentation({ closed, overlay, dockable }) };
}
