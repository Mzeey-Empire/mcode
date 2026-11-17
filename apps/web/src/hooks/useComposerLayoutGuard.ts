import { useEffect, type RefObject } from "react";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";
import { rightPanelPosture, setLayoutMeasurements } from "@/lib/composer-layout";

/** Inputs that affect composer-first layout enforcement. */
export interface ComposerLayoutGuardOptions {
  readonly settingsOpen: boolean;
  readonly showLanding: boolean;
  readonly showPullRequests: boolean;
  readonly activeWorkspaceId: string | null;
  readonly activeThreadId: string | null;
}

/**
 * The content row holds both the conversation and the panel, so its width does not depend on the panel's posture.
 * A panel that cannot dock floats over the conversation; only a row too narrow to show both maximizes it.
 */
function enforceThreadLayout(contentWidth: number, workspaceId: string, threadId: string | null): void {
  const ui = useUiStore.getState();
  const diff = useDiffStore.getState();
  const panelVisible = diff.getRightPanelVisible(workspaceId, threadId);
  if (!panelVisible) return;
  const fits = rightPanelPosture(contentWidth) !== "full-surface";
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
 * Composer-first responsive guard: on shrink, maximizes the right panel only when
 * the conversation and a floating panel can no longer share the content row, and
 * restores it when room returns. The docked project tree is never moved; it only
 * narrows the content row. Publishes the live content-row width for adaptive
 * open paths.
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
  // Opening the panel does not resize the content row, and a floating panel never resizes it, so this reruns the guard.
  const rightPanelVisible = useDiffStore((s) => activeWorkspaceId !== null && s.getRightPanelVisible(activeWorkspaceId, activeThreadId));

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
    rightPanelVisible,
  ]);
}
