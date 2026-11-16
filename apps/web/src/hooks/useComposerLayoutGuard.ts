import { useEffect, type RefObject } from "react";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { canFitSideBySidePanel, setLayoutMeasurements } from "@/lib/composer-layout";

/** Inputs that affect composer-first layout enforcement. */
export interface ComposerLayoutGuardOptions {
  readonly settingsOpen: boolean;
  readonly showLanding: boolean;
  readonly showPullRequests: boolean;
  readonly activeWorkspaceId: string | null;
  readonly activeThreadId: string | null;
}

function enforceThreadLayout(contentWidth: number, workspaceId: string, threadId: string | null): void {
  const ui = useUiStore.getState();
  const diff = useDiffStore.getState();
  const panelVisible = diff.getRightPanelVisible(workspaceId, threadId);
  if (!panelVisible) return;
  const panelWidth = diff.getRightPanel(workspaceId, threadId).width;
  const fits = canFitSideBySidePanel(contentWidth, panelWidth);
  if (ui.rightPanelMaximized) {
    if (ui.rightPanelMaximizedByLayout && fits) ui.setRightPanelMaximized(false);
    return;
  }
  if (!fits) ui.setRightPanelMaximized(true, "layout");
}

function enforceComposerLayout(contentWidth: number, opts: ComposerLayoutGuardOptions): void {
  setLayoutMeasurements(contentWidth);
  if (opts.showPullRequests || opts.showLanding || !opts.activeWorkspaceId) return;
  enforceThreadLayout(contentWidth, opts.activeWorkspaceId, opts.activeThreadId);
}

/**
 * Composer-first responsive guard: on shrink, maximizes the inline right panel
 * before the chat/composer can fall below its minimum width, and restores it
 * side by side when room returns. The docked project tree is never moved; it
 * only narrows the content row. Publishes the live content-row width for
 * adaptive open paths.
 */
export function useComposerLayoutGuard(
  contentRowRef: RefObject<HTMLElement | null>,
  opts: ComposerLayoutGuardOptions,
): void {
  const {
    settingsOpen,
    showLanding,
    showPullRequests,
    activeWorkspaceId,
    activeThreadId,
  } = opts;
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const rightPanelMaximized = useUiStore((s) => s.rightPanelMaximized);
  const rightPanelMaximizedByLayout = useUiStore((s) => s.rightPanelMaximizedByLayout);

  useEffect(() => {
    if (settingsOpen) return;

    const content = contentRowRef.current;
    if (!content) return;

    const enforce = () => {
      enforceComposerLayout(content.clientWidth, {
        settingsOpen,
        showLanding,
        showPullRequests,
        activeWorkspaceId,
        activeThreadId,
      });
    };

    enforce();

    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        enforce();
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(content);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    contentRowRef,
    settingsOpen,
    showLanding,
    showPullRequests,
    activeWorkspaceId,
    activeThreadId,
    sidebarCollapsed,
    rightPanelMaximized,
    rightPanelMaximizedByLayout,
  ]);
}
