import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockThread } from "@/__tests__/mocks/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useOpenPlanWhenReady } from "./use-open-plan-when-ready";

const { showRightPanelAdaptive, setRightPanelTab } = vi.hoisted(() => ({
  showRightPanelAdaptive: vi.fn(),
  setRightPanelTab: vi.fn(),
}));

vi.mock("@/lib/right-panel-layout", () => ({ showRightPanelAdaptive }));
vi.mock("@/stores/diffStore", () => ({
  useDiffStore: { getState: () => ({ setRightPanelTab }) },
}));

const READY = createMockThread({ id: "ready", workspace_id: "ws-1", plan_phase: "ready" });
const QUESTIONS = createMockThread({ id: "asking", workspace_id: "ws-1", plan_phase: "questions" });

describe("useOpenPlanWhenReady", () => {
  beforeEach(() => {
    showRightPanelAdaptive.mockClear();
    setRightPanelTab.mockClear();
    useWorkspaceStore.setState({ threads: [READY, QUESTIONS] });
  });

  it("opens the Plan tab when the user switches to a thread whose plan is ready", () => {
    const { rerender } = renderHook(({ id }) => useOpenPlanWhenReady(id), { initialProps: { id: "asking" as string | null } });
    expect(showRightPanelAdaptive).not.toHaveBeenCalled();

    rerender({ id: "ready" });

    expect(showRightPanelAdaptive).toHaveBeenCalledWith("ws-1", "ready");
    expect(setRightPanelTab).toHaveBeenCalledWith("ws-1", "ready", "tasks");
  });

  it("stays closed when a plan becomes ready on the thread the user is already viewing", () => {
    useWorkspaceStore.setState({ threads: [QUESTIONS] });
    renderHook(() => useOpenPlanWhenReady("asking"));

    act(() => useWorkspaceStore.setState({ threads: [{ ...QUESTIONS, plan_phase: "ready" }] }));

    expect(showRightPanelAdaptive).not.toHaveBeenCalled();
  });
});
