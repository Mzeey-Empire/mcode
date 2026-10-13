import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useUiStore } from "@/stores/uiStore";

const mocks = vi.hoisted(() => ({ showRightPanelAdaptive: vi.fn() }));
vi.mock("@/lib/right-panel-layout", () => ({ showRightPanelAdaptive: mocks.showRightPanelAdaptive }));

import { openSubagentDetail, openSubagentsPanel } from "../open-subagent-detail";

describe("openSubagentDetail", () => {
  beforeEach(() => {
    mocks.showRightPanelAdaptive.mockClear();
    useWorkspaceStore.setState({ activeWorkspaceId: "workspace-1", activeThreadId: "thread-1" });
    useDiffStore.setState({ rightPanelByThread: {}, rightPanelFallbackByWorkspace: {} });
    useUiStore.setState({ rightPanelMaximized: false, rightPanelMaximizedByLayout: false });
  });

  it("opens the entry as its own rail tab after Subagents", () => {
    expect(openSubagentDetail("agent-1")).toBe(true);

    const panel = useDiffStore.getState().getRightPanel("workspace-1", "thread-1");
    expect(panel.tabInstances.map((tab) => tab.id)).toEqual(["singleton:subagents", "subagent:agent-1"]);
    expect(panel.activeTabId).toBe("subagent:agent-1");
    expect(panel.openTabs).toEqual(["subagents"]);
    expect(mocks.showRightPanelAdaptive).toHaveBeenCalledWith("workspace-1", "thread-1");
    expect(useUiStore.getState()).toMatchObject({
      rightPanelMaximized: false,
      rightPanelMaximizedByLayout: false,
    });
  });

  it("does nothing without an active thread scope", () => {
    useWorkspaceStore.setState({ activeThreadId: null });
    expect(openSubagentDetail("agent-1")).toBe(false);
    expect(mocks.showRightPanelAdaptive).not.toHaveBeenCalled();
  });

  it("returns from an open subagent tab to the Subagents list", () => {
    openSubagentDetail("agent-1");
    expect(openSubagentsPanel()).toBe(true);

    const panel = useDiffStore.getState().getRightPanel("workspace-1", "thread-1");
    expect(panel.activeTabId).toBe("singleton:subagents");
    expect(panel.tabInstances.map((tab) => tab.id)).toEqual(["singleton:subagents", "subagent:agent-1"]);
  });
});
