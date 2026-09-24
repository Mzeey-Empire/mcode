import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isModifierClick,
  isPreviewableUrl,
  isEmptyPreviewTabUrl,
  openUrlInPreview,
  openGitHubUrl,
} from "../open-url-in-preview";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { createMockWorkspace, createMockThread } from "@/__tests__/mocks/transport";
import {
  previewTabsScopeKey,
  usePreviewTabsStore,
} from "../../state/previewTabsStore";

describe("isModifierClick", () => {
  it("returns true for ctrl+click", () => {
    expect(isModifierClick({ ctrlKey: true, metaKey: false })).toBe(true);
  });

  it("returns true for cmd+click", () => {
    expect(isModifierClick({ ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("returns false for plain click", () => {
    expect(isModifierClick({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("isPreviewableUrl", () => {
  it("accepts https URLs", () => {
    expect(isPreviewableUrl("https://example.com")).toBe(true);
  });

  it("accepts mcode-workspace URLs", () => {
    expect(isPreviewableUrl("mcode-workspace:///page.html")).toBe(true);
  });

  it("accepts absolute Windows paths", () => {
    expect(isPreviewableUrl("C:/workspace/hello-world.html")).toBe(true);
  });

  it("rejects mailto URLs", () => {
    expect(isPreviewableUrl("mailto:test@example.com")).toBe(false);
  });
});

describe("isEmptyPreviewTabUrl", () => {
  it("treats null, blank, and about: URLs as empty", () => {
    expect(isEmptyPreviewTabUrl(null)).toBe(true);
    expect(isEmptyPreviewTabUrl("")).toBe(true);
    expect(isEmptyPreviewTabUrl("about:blank")).toBe(true);
  });

  it("treats loaded http(s) URLs as non-empty", () => {
    expect(isEmptyPreviewTabUrl("https://example.com")).toBe(false);
  });
});

function mockTabList(activeUrl: string | null) {
  return vi.fn().mockResolvedValue({
    ok: true,
    data: {
      threadId: "thread-1",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          threadId: "thread-1",
          title: activeUrl ? "Loaded" : null,
          url: activeUrl,
          faviconUrl: null,
          warm: true,
          active: true,
        },
      ],
    },
  });
}

/** The host's `tabs.open` response carries the full post-open tab set. */
function openedTabSet() {
  return {
    threadId: "thread-1",
    activeTabId: "tab-2",
    tabs: [
      { id: "tab-1", threadId: "thread-1", title: null, url: null, faviconUrl: null, warm: true, active: false },
      { id: "tab-2", threadId: "thread-1", title: null, url: null, faviconUrl: null, warm: true, active: true },
    ],
  };
}

describe("openUrlInPreview", () => {
  let mockOpen: ReturnType<typeof vi.fn>;
  let mockNavigate: ReturnType<typeof vi.fn>;
  let mockResolveNavigation: ReturnType<typeof vi.fn>;
  let mockOpenExternalUrl: ReturnType<typeof vi.fn>;
  let showRightPanel: ReturnType<typeof vi.fn>;
  let setRightPanelTab: ReturnType<typeof vi.fn>;
  let setPreviewUrlForThread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockOpen = vi.fn().mockResolvedValue({ ok: true, data: { tabId: "tab-2", tabs: openedTabSet() } });
    mockNavigate = vi.fn().mockResolvedValue({ ok: true });
    mockResolveNavigation = vi.fn(async (url: string) => ({ ok: true, url }));
    mockOpenExternalUrl = vi.fn().mockResolvedValue(undefined);
    showRightPanel = vi.fn();
    setRightPanelTab = vi.fn();
    setPreviewUrlForThread = vi.fn();

    useDiffStore.setState({
      showRightPanel,
      setRightPanelTab,
      setPreviewUrlForThread,
    } as Partial<ReturnType<typeof useDiffStore.getState>>);

    const ws = createMockWorkspace({ id: "ws-1", path: "/tmp/workspace" });
    useWorkspaceStore.setState({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      activeThreadId: "thread-1",
      threads: [createMockThread({ id: "thread-1", workspace_id: ws.id })],
    });

    window.desktopBridge = {
      openExternalUrl: mockOpenExternalUrl,
      preview: {
        tabs: { open: mockOpen, list: mockTabList("https://example.com") },
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
      },
    } as unknown as typeof window.desktopBridge;
    usePreviewTabsStore.setState({ pendingNavErrorsByScope: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    useWorkspaceStore.setState({
      workspaces: [],
      activeWorkspaceId: null,
      activeThreadId: null,
    });
    usePreviewTabsStore.setState({ pendingNavErrorsByScope: {} });
  });

  it("creates a new tab then navigates when the active tab already has a page", async () => {
    openUrlInPreview({ url: "https://example.com/pr/1", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(showRightPanel).toHaveBeenCalledWith("ws-1", "thread-1");
    expect(setRightPanelTab).toHaveBeenCalledWith("ws-1", "thread-1", "preview");
    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", {
      activate: true,
      initialAddress: "https://example.com/pr/1",
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com/pr/1");
  });

  it("reuses an empty active tab instead of creating another", async () => {
    window.desktopBridge = {
      preview: {
        tabs: { open: mockOpen, list: mockTabList(null) },
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
      },
    } as unknown as typeof window.desktopBridge;

    openUrlInPreview({ url: "https://example.com/pr/1", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", {
      activate: true,
      tabId: "tab-1",
      initialAddress: "https://example.com/pr/1",
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com/pr/1");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates active tab without creating when newTab is false", async () => {
    openUrlInPreview({
      url: "https://example.com",
      threadId: "thread-1",
      newTab: false,
    });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", {
      activate: true,
      tabId: "tab-1",
      initialAddress: "https://example.com",
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("falls back to window.open when preview bridge is missing", () => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    openUrlInPreview({ url: "https://example.com", threadId: "thread-1" });

    expect(mockOpen).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });

  it("opens an activated error tab when resolution reports a missing file", async () => {
    mockResolveNavigation.mockResolvedValue({ ok: false, error: "file-not-found" });

    openUrlInPreview({ url: "C:\\missing\\page.html", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    // The known-bad address must not go back through initialAddress; the
    // pending error record is what renders the page.
    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", { activate: true });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
    expect(setPreviewUrlForThread).not.toHaveBeenCalled();
    const pending = usePreviewTabsStore.getState()
      .pendingNavErrorsByScope[previewTabsScopeKey("ws-1", "thread-1")]?.["tab-2"];
    expect(pending?.input).toBe("C:\\missing\\page.html");
    expect(pending?.error).toMatchObject({
      kind: "file-not-found",
      message: "File not found",
    });
  });

  it("opens an error tab for hint-only codes instead of dead-clicking", async () => {
    mockResolveNavigation.mockResolvedValue({ ok: false, error: "no-workspace" });

    openUrlInPreview({ url: "docs/report.html", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", { activate: true });
    const pending = usePreviewTabsStore.getState()
      .pendingNavErrorsByScope[previewTabsScopeKey("ws-1", "thread-1")]?.["tab-2"];
    expect(pending?.error.message).toBe("Open a workspace to use relative file paths.");
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it("reuses an empty active tab for the error page", async () => {
    mockResolveNavigation.mockResolvedValue({ ok: false, error: "file-not-found" });
    window.desktopBridge = {
      openExternalUrl: mockOpenExternalUrl,
      preview: {
        tabs: { open: mockOpen, list: mockTabList(null) },
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
      },
    } as unknown as typeof window.desktopBridge;

    openUrlInPreview({ url: "C:\\missing\\page.html", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalledWith("thread-1", "ws-1", {
      activate: true,
      tabId: "tab-1",
    });
  });

  it("falls back to external when the error tab itself cannot open", async () => {
    mockResolveNavigation.mockResolvedValue({ ok: false, error: "file-not-found" });
    mockOpen.mockResolvedValue({ ok: false, error: "tab-unavailable" });

    openUrlInPreview({ url: "C:\\missing\\page.html", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpenExternalUrl).toHaveBeenCalledWith("C:\\missing\\page.html");
  });

  it("opens an error tab when the file vanishes between resolve and tab open", async () => {
    mockOpen
      .mockResolvedValueOnce({ ok: false, error: "invalid-initial-address" })
      .mockResolvedValue({ ok: true, data: { tabId: "tab-2", tabs: openedTabSet() } });
    mockResolveNavigation
      .mockResolvedValueOnce({ ok: true, url: "file:///C:/missing/page.html" })
      .mockResolvedValueOnce({ ok: false, error: "file-not-found" });

    openUrlInPreview({ url: "C:\\missing\\page.html", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    const pending = usePreviewTabsStore.getState()
      .pendingNavErrorsByScope[previewTabsScopeKey("ws-1", "thread-1")]?.["tab-2"];
    expect(pending?.error.kind).toBe("file-not-found");
    expect(setPreviewUrlForThread).not.toHaveBeenCalled();
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it("resolves relative paths against the clicked thread's workspace", async () => {
    const other = createMockWorkspace({ id: "ws-2", path: "/tmp/other-workspace" });
    useWorkspaceStore.setState({
      workspaces: [createMockWorkspace({ id: "ws-1", path: "/tmp/workspace" }), other],
      activeWorkspaceId: "ws-1",
      activeThreadId: "thread-2",
      threads: [createMockThread({ id: "thread-2", workspace_id: "ws-2" })],
    });

    openUrlInPreview({ url: "docs/report.html", threadId: "thread-2" });
    await vi.runAllTimersAsync();

    expect(mockResolveNavigation).toHaveBeenCalledWith("docs/report.html", "/tmp/other-workspace");
  });

  it("retries as a fresh tab when the listed reuse target was closed", async () => {
    // Active tab is empty, so the first open targets it by id; the host then
    // reports it gone (closed between list and open).
    window.desktopBridge = {
      openExternalUrl: mockOpenExternalUrl,
      preview: {
        tabs: { open: mockOpen, list: mockTabList(null) },
        navigate: mockNavigate,
        resolveNavigation: mockResolveNavigation,
      },
    } as unknown as typeof window.desktopBridge;
    mockOpen
      .mockResolvedValueOnce({ ok: false, error: "tab-not-found" })
      .mockResolvedValueOnce({ ok: true, data: { tabId: "tab-2", tabs: openedTabSet() } });

    openUrlInPreview({ url: "https://example.com/pr/1", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenNthCalledWith(1, "thread-1", "ws-1", {
      activate: true,
      tabId: "tab-1",
      initialAddress: "https://example.com/pr/1",
    });
    expect(mockOpen).toHaveBeenNthCalledWith(2, "thread-1", "ws-1", {
      activate: true,
      initialAddress: "https://example.com/pr/1",
    });
    expect(setPreviewUrlForThread).toHaveBeenCalledWith("thread-1", "https://example.com/pr/1");
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it("opens externally when tab creation fails entirely", async () => {
    mockOpen.mockResolvedValue({ ok: false, error: "tab-unavailable" });

    openUrlInPreview({ url: "https://example.com/next", threadId: "thread-1" });
    await vi.runAllTimersAsync();

    expect(mockOpen).toHaveBeenCalled();
    expect(setPreviewUrlForThread).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockOpenExternalUrl).toHaveBeenCalledWith("https://example.com/next");
  });
});

describe("openGitHubUrl", () => {
  let mockOpenExternal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOpenExternal = vi.fn();
    window.desktopBridge = {
      openExternalUrl: mockOpenExternal,
      preview: {
        tabs: {
          open: vi.fn().mockResolvedValue({ ok: true, data: {} }),
          list: mockTabList("https://github.com/org/repo/pull/1"),
        },
        navigate: vi.fn().mockResolvedValue({ ok: true }),
        resolveNavigation: vi.fn(async (url: string) => ({ ok: true, url })),
      },
    } as unknown as typeof window.desktopBridge;

    useDiffStore.setState({
      showRightPanel: vi.fn(),
      setRightPanelTab: vi.fn(),
      setPreviewUrlForThread: vi.fn(),
    } as Partial<ReturnType<typeof useDiffStore.getState>>);

    useWorkspaceStore.setState({ activeThreadId: "thread-1", workspaces: [], activeWorkspaceId: null });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>).desktopBridge;
  });

  it("opens in system browser on plain click", () => {
    openGitHubUrl("https://github.com/org/repo/pull/1", "thread-1");
    expect(mockOpenExternal).toHaveBeenCalledWith("https://github.com/org/repo/pull/1");
  });

  it("falls back to window.open when desktopBridge is missing on plain click", () => {
    delete (window as unknown as Record<string, unknown>).desktopBridge;
    const mockOpen = vi.fn();
    vi.stubGlobal("open", mockOpen);

    openGitHubUrl("https://github.com/org/repo/pull/1", "thread-1");

    expect(mockOpen).toHaveBeenCalledWith(
      "https://github.com/org/repo/pull/1",
      "_blank",
      "noopener,noreferrer",
    );
    vi.unstubAllGlobals();
  });

  it("opens in preview on ctrl+click", async () => {
    const mockOpen = vi.mocked(window.desktopBridge!.preview!.tabs!.open);
    openGitHubUrl(
      "https://github.com/org/repo/pull/1",
      "thread-1",
      { ctrlKey: true, metaKey: false },
    );
    await vi.runAllTimersAsync();
    expect(mockOpenExternal).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalled();
  });
});
