import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerLayoutGuard } from "../useComposerLayoutGuard";
import { useUiStore } from "@/stores/uiStore";
import { useDiffStore } from "@/stores/diffStore";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";

let resizeCallback: ResizeObserverCallback | null = null;
let frameCallback: FrameRequestCallback | null = null;

class ResizeObserverMock implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function LayoutHarness({
  contentWidth,
  showPullRequests = true,
  showLanding = true,
  activeWorkspaceId = null,
  activeThreadId = null,
}: {
  contentWidth: number;
  showPullRequests?: boolean;
  showLanding?: boolean;
  activeWorkspaceId?: string | null;
  activeThreadId?: string | null;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  if (!contentRef.current) contentRef.current = document.createElement("div");
  Object.defineProperty(contentRef.current, "clientWidth", {
    configurable: true,
    value: contentWidth,
  });

  useComposerLayoutGuard(contentRef, {
    settingsOpen: false,
    showLanding,
    showPullRequests,
    activeWorkspaceId,
    activeThreadId,
  });
  return null;
}

function triggerResize(): void {
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
    const callback = frameCallback;
    frameCallback = null;
    callback?.(0);
  });
}

describe("useComposerLayoutGuard responsive layout", () => {
  beforeEach(() => {
    resizeCallback = null;
    frameCallback = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useUiStore.setState({
      primarySurface: "pullRequests",
      sidebarCollapsed: false,
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { surface: "pull requests", showPullRequests: true, showLanding: true, activeWorkspaceId: null },
    { surface: "projectless landing", showPullRequests: false, showLanding: true, activeWorkspaceId: null },
    { surface: "new-thread canvas", showPullRequests: false, showLanding: false, activeWorkspaceId: "workspace-1" },
  ])("keeps an open sidebar docked on a narrow $surface", (props) => {
    render(<LayoutHarness contentWidth={188} {...props} />);
    triggerResize();

    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it("maximizes an inline right panel that no longer fits beside the composer, leaving the sidebar docked", () => {
    setLayoutMeasurements(1_200);
    showRightPanelAdaptive("workspace-1", "thread-1");

    render(
      <LayoutHarness
        contentWidth={700}
        showPullRequests={false}
        showLanding={false}
        activeWorkspaceId="workspace-1"
        activeThreadId="thread-1"
      />,
    );

    expect(useUiStore.getState()).toMatchObject({
      rightPanelMaximized: true,
      rightPanelMaximizedByLayout: true,
      sidebarCollapsed: false,
    });
  });

  function renderWideningThreadLayout(): void {
    setLayoutMeasurements(1_200);
    showRightPanelAdaptive("workspace-1", "thread-1");
    const props = {
      showPullRequests: false,
      showLanding: false,
      activeWorkspaceId: "workspace-1",
      activeThreadId: "thread-1",
    };
    const { rerender } = render(<LayoutHarness contentWidth={700} {...props} />);
    rerender(<LayoutHarness contentWidth={3_000} {...props} />);
    triggerResize();
  }

  it("restores a panel the layout maximized once the composer and panel fit again", () => {
    useUiStore.getState().setRightPanelMaximized(true, "layout");

    renderWideningThreadLayout();

    expect(useUiStore.getState().rightPanelMaximized).toBe(false);
  });

  it("keeps a panel the user maximized after the content row widens", () => {
    useUiStore.getState().setRightPanelMaximized(true);

    renderWideningThreadLayout();

    expect(useUiStore.getState().rightPanelMaximized).toBe(true);
  });
});
