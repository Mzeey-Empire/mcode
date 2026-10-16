import { useDiffStore, type RightPanelTool } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import {
  canFitSideBySidePanel,
  getContentRowWidth,
  preferredSplitPanelWidth,
} from "@/lib/composer-layout";

/**
 * On auto-owned opens, size the panel to ~half the current content row. A width
 * the user dragged is marked user-owned and is never overridden here.
 */
function applyHalfWidthIfUntouched(workspaceId: string, threadId?: string | null): void {
  const diff = useDiffStore.getState();
  if (diff.getRightPanel(workspaceId, threadId).widthSource === "user") return;
  diff.setRightPanelWidth(
    workspaceId,
    threadId,
    preferredSplitPanelWidth(getContentRowWidth()),
    "auto",
  );
}

/**
 * After opening the right panel, maximize it when the content row cannot fit
 * composer and panel side by side. Composer-first: inline mode only when there
 * is room; otherwise the panel owns the content row. The width is read from the
 * scope's effective panel record (the thread's own, or the workspace fallback).
 */
export function applyMaximizeIfCramped(
  workspaceId: string,
  threadId?: string | null,
): void {
  const panelWidth = useDiffStore.getState().getRightPanel(workspaceId, threadId).width;
  if (canFitSideBySidePanel(getContentRowWidth(), panelWidth)) return;
  useUiStore.getState().setRightPanelMaximized(true, "layout");
}

/**
 * Opens the right panel for a workspace/thread and applies cramped-layout maximize.
 */
export function showRightPanelAdaptive(
  workspaceId: string,
  threadId?: string | null,
): void {
  useDiffStore.getState().showRightPanel(workspaceId, threadId);
  applyHalfWidthIfUntouched(workspaceId, threadId);
  applyMaximizeIfCramped(workspaceId, threadId);
}

/** Opens the right panel for a workspace/thread and selects `tab`. */
export function openRightPanelTab(
  workspaceId: string,
  threadId: string | null | undefined,
  tab: RightPanelTool,
): void {
  showRightPanelAdaptive(workspaceId, threadId);
  useDiffStore.getState().setRightPanelTab(workspaceId, threadId, tab);
}

/**
 * Toggles the right panel; on open applies cramped-layout maximize, on close
 * clears maximize so the chat pane returns cleanly.
 */
export function toggleRightPanelAdaptive(
  workspaceId: string,
  threadId?: string | null,
): void {
  const diff = useDiffStore.getState();
  const wasVisible = diff.getRightPanelVisible(workspaceId, threadId);
  diff.toggleRightPanel(workspaceId, threadId);
  if (wasVisible) {
    useUiStore.getState().setRightPanelMaximized(false);
    return;
  }
  applyHalfWidthIfUntouched(workspaceId, threadId);
  applyMaximizeIfCramped(workspaceId, threadId);
}

/**
 * Hides the right panel for the active workspace/thread and clears maximize.
 */
export function hideRightPanelAdaptive(workspaceId: string, threadId?: string | null): void {
  useDiffStore.getState().hideRightPanel(workspaceId, threadId);
  useUiStore.getState().setRightPanelMaximized(false);
}

/**
 * Puts the chat on screen for a reveal. Clearing maximize alone is not enough
 * when chat and panel cannot fit side by side: the layout guard maximizes again.
 */
export function showChatAdaptive(workspaceId: string, threadId?: string | null): void {
  const panelWidth = useDiffStore.getState().getRightPanel(workspaceId, threadId).width;
  if (canFitSideBySidePanel(getContentRowWidth(), panelWidth)) {
    useUiStore.getState().setRightPanelMaximized(false);
    return;
  }
  hideRightPanelAdaptive(workspaceId, threadId);
}

/** Active workspace/thread hide helper for layout guard and Escape paths. */
export function hideActiveRightPanelAdaptive(): void {
  const { activeWorkspaceId, activeThreadId } = useWorkspaceStore.getState();
  if (!activeWorkspaceId) return;
  hideRightPanelAdaptive(activeWorkspaceId, activeThreadId);
}
