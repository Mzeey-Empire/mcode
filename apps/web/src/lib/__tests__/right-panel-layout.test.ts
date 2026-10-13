import { beforeEach, describe, expect, it } from "vitest";
import { setLayoutMeasurements } from "@/lib/composer-layout";
import {
  hideRightPanelAdaptive,
  showChatAdaptive,
  showRightPanelAdaptive,
} from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useUiStore } from "@/stores/uiStore";

describe("right-panel-layout", () => {
  beforeEach(() => {
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useUiStore.setState({ rightPanelMaximized: false, rightPanelMaximizedByLayout: false });
    setLayoutMeasurements(1200, 1200);
  });

  it("recomputes auto-owned panel width from the current chat row on each open", () => {
    showRightPanelAdaptive("ws-1", "thread-1");
    expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      width: 600,
      widthSource: "auto",
    });

    hideRightPanelAdaptive("ws-1", "thread-1");
    setLayoutMeasurements(1000, 1000);
    showRightPanelAdaptive("ws-1", "thread-1");

    expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      width: 500,
      widthSource: "auto",
    });
  });

  it("does not overwrite a user-owned panel width on reopen", () => {
    showRightPanelAdaptive("ws-1", "thread-1");
    useDiffStore.getState().setRightPanelWidth("ws-1", "thread-1", 520, "user");

    hideRightPanelAdaptive("ws-1", "thread-1");
    setLayoutMeasurements(1400, 1400);
    showRightPanelAdaptive("ws-1", "thread-1");

    expect(useDiffStore.getState().getRightPanel("ws-1", "thread-1")).toMatchObject({
      width: 520,
      widthSource: "user",
    });
  });

  it("shows the chat beside a maximized panel when both fit", () => {
    showRightPanelAdaptive("ws-1", "thread-1");
    useUiStore.getState().setRightPanelMaximized(true);

    showChatAdaptive("ws-1", "thread-1");

    expect(useUiStore.getState().rightPanelMaximized).toBe(false);
    expect(useDiffStore.getState().getRightPanelVisible("ws-1", "thread-1")).toBe(true);
  });

  it("hides the panel to show the chat when both cannot fit", () => {
    setLayoutMeasurements(700, 700);
    showRightPanelAdaptive("ws-1", "thread-1");
    expect(useUiStore.getState().rightPanelMaximized).toBe(true);

    showChatAdaptive("ws-1", "thread-1");

    expect(useUiStore.getState().rightPanelMaximized).toBe(false);
    expect(useDiffStore.getState().getRightPanelVisible("ws-1", "thread-1")).toBe(false);
  });
});
