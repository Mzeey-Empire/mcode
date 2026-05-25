import { describe, it, expect, beforeEach } from "vitest";
import {
  useDiffStore,
  PANEL_MIN_WIDTH,
  getDefaultPanelWidthPx,
  createDefaultRightPanelState,
  DEFAULT_LINE_WRAP,
} from "../stores/diffStore";

describe("diffStore", () => {
  beforeEach(() => {
    useDiffStore.setState({
      previewUrlByThread: {},
      rightPanelByThread: {},
      snapshotsByThread: {},
      snapshotsLoadingByThread: {},
      snapshotsPendingByThread: {},
      commitsByThread: {},
      commitsLoadingByThread: {},
      selectedFile: null,
      diffContent: null,
      diffLoading: false,
      viewMode: "by-turn",
      renderMode: "unified",
      lineWrapByThread: {},
    });
  });

  describe("line wrap", () => {
    it("defaults to wrapped for threads with no stored preference", () => {
      const { getLineWrap } = useDiffStore.getState();
      expect(getLineWrap("thread-1")).toBe(DEFAULT_LINE_WRAP);
      expect(DEFAULT_LINE_WRAP).toBe(true);
    });

    it("toggles and stores preference per thread", () => {
      const { toggleLineWrap, getLineWrap } = useDiffStore.getState();
      expect(getLineWrap("thread-1")).toBe(true);
      toggleLineWrap("thread-1");
      expect(getLineWrap("thread-1")).toBe(false);
      expect(getLineWrap("thread-2")).toBe(true);
      toggleLineWrap("thread-1");
      expect(getLineWrap("thread-1")).toBe(true);
    });

    it("clears stored preference when the thread is cleared", () => {
      const { toggleLineWrap, getLineWrap, clearThread } = useDiffStore.getState();
      toggleLineWrap("thread-1");
      expect(getLineWrap("thread-1")).toBe(false);
      clearThread("thread-1");
      expect(getLineWrap("thread-1")).toBe(true);
      expect(useDiffStore.getState().lineWrapByThread["thread-1"]).toBeUndefined();
    });
  });

  describe("getRightPanel", () => {
    it("should return defaults for unknown thread", () => {
      const { getRightPanel } = useDiffStore.getState();
      expect(getRightPanel("unknown")).toEqual(createDefaultRightPanelState());
    });

    it("should return stored state for known thread", () => {
      const { showRightPanel, getRightPanel } = useDiffStore.getState();
      showRightPanel("thread-1");
      expect(getRightPanel("thread-1").visible).toBe(true);
    });
  });

  describe("toggleRightPanel", () => {
    it("should flip visibility for one thread", () => {
      const { toggleRightPanel, getRightPanel } = useDiffStore.getState();
      toggleRightPanel("thread-1");
      expect(getRightPanel("thread-1").visible).toBe(true);
      toggleRightPanel("thread-1");
      expect(getRightPanel("thread-1").visible).toBe(false);
    });

    it("should not affect other threads", () => {
      const { toggleRightPanel, getRightPanel } = useDiffStore.getState();
      toggleRightPanel("thread-1");
      expect(getRightPanel("thread-2").visible).toBe(false);
    });
  });

  describe("showRightPanel / hideRightPanel", () => {
    it("showRightPanel sets visible true without affecting width", () => {
      const { showRightPanel, setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("thread-1", 500);
      showRightPanel("thread-1");
      const panel = getRightPanel("thread-1");
      expect(panel.visible).toBe(true);
      expect(panel.width).toBe(500);
    });

    it("hideRightPanel sets visible false without affecting tab", () => {
      const { showRightPanel, hideRightPanel, setRightPanelTab, getRightPanel } = useDiffStore.getState();
      showRightPanel("thread-1");
      setRightPanelTab("thread-1", "changes");
      hideRightPanel("thread-1");
      const panel = getRightPanel("thread-1");
      expect(panel.visible).toBe(false);
      expect(panel.activeTab).toBe("changes");
    });
  });

  describe("setRightPanelWidth", () => {
    it("should update width for one thread", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("thread-1", 500);
      expect(getRightPanel("thread-1").width).toBe(500);
      expect(getRightPanel("thread-2").width).toBe(getDefaultPanelWidthPx());
    });

    it("should clamp width to PANEL_MIN_WIDTH", () => {
      const { setRightPanelWidth, getRightPanel } = useDiffStore.getState();
      setRightPanelWidth("thread-1", 100);
      expect(getRightPanel("thread-1").width).toBe(PANEL_MIN_WIDTH);
    });
  });

  describe("setRightPanelTab", () => {
    it("should update active tab for one thread only", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("thread-1", "changes");
      expect(getRightPanel("thread-1").activeTab).toBe("changes");
      expect(getRightPanel("thread-2").activeTab).toBe("tasks");
    });

    it("should support preview tab", () => {
      const { setRightPanelTab, getRightPanel } = useDiffStore.getState();
      setRightPanelTab("thread-1", "preview");
      expect(getRightPanel("thread-1").activeTab).toBe("preview");
    });
  });

  describe("setPreviewUrlForThread", () => {
    it("stores url per thread independently", () => {
      const { setPreviewUrlForThread } = useDiffStore.getState();
      setPreviewUrlForThread("thread-1", "https://a.test");
      setPreviewUrlForThread("thread-2", "https://b.test");
      const state = useDiffStore.getState();
      expect(state.previewUrlByThread["thread-1"]).toBe("https://a.test");
      expect(state.previewUrlByThread["thread-2"]).toBe("https://b.test");
    });
  });

  describe("clearThread", () => {
    it("should remove all per-thread entries", () => {
      const {
        showRightPanel,
        setSnapshots,
        setSnapshotsLoading,
        setCommits,
        setCommitsLoading,
        setPreviewUrlForThread,
        clearThread,
        getRightPanel,
      } =
        useDiffStore.getState();
      showRightPanel("thread-1");
      setSnapshots("thread-1", [{ id: "s1" } as never]);
      setSnapshotsLoading("thread-1", true);
      setCommits("thread-1", [{ sha: "c1" } as never]);
      setCommitsLoading("thread-1", true);
      setPreviewUrlForThread("thread-1", "https://example.com");

      clearThread("thread-1");

      const state = useDiffStore.getState();
      expect(state.previewUrlByThread["thread-1"]).toBeUndefined();
      expect(state.rightPanelByThread["thread-1"]).toBeUndefined();
      expect(getRightPanel("thread-1")).toEqual(createDefaultRightPanelState());
      expect(state.snapshotsByThread["thread-1"]).toBeUndefined();
      expect(state.snapshotsLoadingByThread["thread-1"]).toBeUndefined();
      expect(state.commitsByThread["thread-1"]).toBeUndefined();
      expect(state.commitsLoadingByThread["thread-1"]).toBeUndefined();
    });

    it("should not affect other threads", () => {
      const { showRightPanel, setSnapshots, setSnapshotsLoading, setCommits, setCommitsLoading, clearThread, getRightPanel } =
        useDiffStore.getState();
      showRightPanel("thread-1");
      showRightPanel("thread-2");
      setSnapshots("thread-1", [{ id: "s1" } as never]);
      setSnapshots("thread-2", [{ id: "s2" } as never]);
      setSnapshotsLoading("thread-2", true);
      setCommits("thread-2", [{ sha: "c2" } as never]);
      setCommitsLoading("thread-2", true);

      clearThread("thread-1");

      const state = useDiffStore.getState();
      expect(getRightPanel("thread-2").visible).toBe(true);
      expect(state.snapshotsByThread["thread-2"]).toHaveLength(1);
      expect(state.snapshotsLoadingByThread["thread-2"]).toBe(true);
      expect(state.commitsByThread["thread-2"]).toHaveLength(1);
      expect(state.commitsLoadingByThread["thread-2"]).toBe(true);
    });

    it("should clear selectedFile when it belongs to deleted thread", () => {
      useDiffStore.setState({
        selectedFile: { source: "snapshot", id: "snap-1", filePath: "a.ts", threadId: "thread-1" },
        diffContent: "diff text",
        diffLoading: true,
      });
      useDiffStore.getState().clearThread("thread-1");
      const state = useDiffStore.getState();
      expect(state.selectedFile).toBeNull();
      expect(state.diffContent).toBeNull();
      expect(state.diffLoading).toBe(false);
    });

    it("should preserve selectedFile when it belongs to a different thread", () => {
      const file = { source: "commit" as const, id: "abc123", filePath: "b.ts", threadId: "thread-2" };
      useDiffStore.setState({
        selectedFile: file,
        diffContent: "other diff",
        diffLoading: false,
      });
      useDiffStore.getState().clearThread("thread-1");
      const state = useDiffStore.getState();
      expect(state.selectedFile).toEqual(file);
      expect(state.diffContent).toBe("other diff");
    });
  });

  describe("markSnapshotsPending", () => {
    it("sets the pending flag for the given thread", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBe(true);
    });

    it("clears the pending flag when called with false", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      useDiffStore.getState().markSnapshotsPending("thread-1", false);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBeUndefined();
    });

    it("does not affect other threads", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-2"]).toBeUndefined();
    });

    it("is cleared when setSnapshots runs for the same thread", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      useDiffStore.getState().setSnapshots("thread-1", []);
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBeUndefined();
    });

    it("is cleared by clearThread", () => {
      useDiffStore.getState().markSnapshotsPending("thread-1", true);
      useDiffStore.getState().clearThread("thread-1");
      expect(useDiffStore.getState().snapshotsPendingByThread["thread-1"]).toBeUndefined();
    });
  });

});
