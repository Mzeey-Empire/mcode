/**
 * Composition tests for PreviewPanel.
 *
 * Covers the two rendering paths:
 * 1. Unavailable state - when desktopBridge.preview is absent.
 * 2. Full panel state - when desktopBridge.preview is present (hooks mocked).
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  getDefaultSettings,
  type BrowserAutomationHostDispatch,
} from "@mcode/contracts";

const {
  mockUsePreviewBridge,
  mockUsePreviewTabs,
  mockOnAddElementAnnotation,
  mockCaptureCleanPage,
  mockSchedulePageSnapshot,
  mockCaptureSuccess,
  mockGetProviderCatalog,
} = vi.hoisted(() => ({
  mockUsePreviewBridge: vi.fn(),
  mockUsePreviewTabs: vi.fn<() => {
    tabSet: unknown;
    newTab: () => unknown;
    activateTab: () => unknown;
    closeTab: () => unknown;
  }>(() => ({
    tabSet: null,
    newTab: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
  })),
  mockOnAddElementAnnotation: vi.fn(),
  mockCaptureCleanPage: vi.fn(),
  mockSchedulePageSnapshot: vi.fn(),
  mockCaptureSuccess: {
    current: undefined as ((kind: "viewport" | "region" | "element") => void) | undefined,
  },
  mockGetProviderCatalog: vi.fn().mockResolvedValue({
    providerId: "claude",
    context: { scope: "user" },
    freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
    diagnostics: [],
    entries: [
      { kind: "skill", identity: { providerId: "claude", kind: "skill", nativeId: "commit" }, name: "commit", description: "Create a git commit", source: "user" },
      { kind: "skill", identity: { providerId: "claude", kind: "skill", nativeId: "review-pr" }, name: "review-pr", description: "Review a pull request", source: "user" },
    ],
    selectableAgents: [],
  }),
}));

// Mock hooks before importing the component under test.
vi.mock("../../navigation/usePreviewSurfaceBridge", () => ({
  usePreviewSurfaceBridge: mockUsePreviewBridge,
  formatNavError: (code: string) => code,
}));

// Transport mock keeps provider catalog eager-prefetch from hitting real IPC in
// tests. The mock is shared across all describe blocks; individual tests that
// need specific catalogs override mockGetProviderCatalog directly.
vi.mock("@/transport", () => ({
  getTransport: () => ({
    getProviderCatalog: mockGetProviderCatalog,
    refreshWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../tabs/usePreviewTabs", () => ({
  usePreviewTabs: mockUsePreviewTabs,
}));

vi.mock("../../capture/usePreviewCapture", () => ({
  usePreviewCapture: ({ onSuccess }: {
    readonly onSuccess?: (kind: "viewport" | "region" | "element") => void;
  }) => {
    mockCaptureSuccess.current = onSuccess;
    return {
      screenshotArmed: false,
      elementPickBusy: false,
      anyCaptureActive: false,
      onToggleScreenshot: vi.fn(),
      onAddElementPickPictureReference: vi.fn(),
      onAddElementAnnotation: mockOnAddElementAnnotation,
      captureCleanPage: mockCaptureCleanPage,
    };
  },
}));

vi.mock("../../notes/previewNoteSnapshots", () => ({
  schedulePageSnapshot: mockSchedulePageSnapshot,
}));

vi.mock("../../notes/stagedDraftImages", () => ({
  stageDraftImage: vi.fn(async (_threadId: string, bytes: Uint8Array, name: string) => ({
    stagingId: crypto.randomUUID(),
    name,
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
  })),
  readStagedDraftImage: vi.fn(async () => new Uint8Array([1])),
}));

import {
  PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
  PreviewPanel,
} from "../PreviewPanel";
import { executeWebBrowserDispatch } from "../../automation/browserAutomationWebExecutor";
import { useSettingsStore } from "@/stores/settingsStore";
import { normalizePreviewPageIdentity } from "@mcode/shared/browser-page-identity";
import {
  toBrowserNoteContent,
  usePreviewAnnotationStore,
  type PreviewDraftAnnotation,
} from "../../state/previewAnnotationStore";
import { saveBrowserNote } from "@/features/conversation/composer/draft/draft-submission";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { usePreviewDesignModeStore } from "../../state/previewDesignModeStore";
import { usePreviewPageScrollStore } from "../../state/previewPageScrollStore";
import { useProviderCatalogStore } from "@/stores/providerCatalogStore";
import { previewTabsScopeKey, usePreviewTabsStore } from "../../state/previewTabsStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  browserAutomationTargetKey,
  useBrowserAutomationStore,
} from "../../automation/browserAutomationStore";
import { ViewportCoordinator } from "../../automation/services/viewportCoordinator";
import { browserSurfaceHost } from "../BrowserSurfaceHostRoot";
import { pushEmitter } from "@/transport/ws-transport";

function mockBridgeState(overrides: Record<string, unknown> = {}) {
  const state = {
    inputUrl: "",
    setInputUrl: vi.fn(),
    navError: null,
    canBack: false,
    canFwd: false,
    previewLoading: false,
    pageTitle: null,
    faviconUrl: null,
    pageStatus: { url: null, title: null, favicon: null, phase: "loaded" },
    storedUrl: "",
    pushSync: vi.fn(),
    refreshNav: vi.fn(),
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onReload: vi.fn(),
    onOpenExternal: vi.fn(),
    resolveNavigation: vi.fn().mockResolvedValue({ ok: true, url: "https://example.com" }),
    onNavigate: vi.fn(),
    onRetry: vi.fn(),
    onForceReload: vi.fn(),
    onClearCookies: vi.fn(),
    onClearCache: vi.fn(),
    onGetZoom: vi.fn().mockResolvedValue(1),
    onSetZoom: vi.fn().mockResolvedValue(1),
  };
  return { ...state, ...overrides };
}

function installMockWebviewMethods(options: {
  readonly loadURL?: (url: string) => Promise<void>;
  readonly getURL?: () => string;
  readonly getWebContentsId?: () => number;
  readonly reload?: () => void;
}): () => void {
  const proto = HTMLElement.prototype as HTMLElement & {
    loadURL?: (url: string) => Promise<void>;
    getURL?: () => string;
    getWebContentsId?: () => number;
    reload?: () => void;
    canGoBack?: () => boolean;
    canGoForward?: () => boolean;
  };
  const loadURLDescriptor = Object.getOwnPropertyDescriptor(proto, "loadURL");
  const getURLDescriptor = Object.getOwnPropertyDescriptor(proto, "getURL");
  const getWebContentsIdDescriptor = Object.getOwnPropertyDescriptor(
    proto,
    "getWebContentsId",
  );
  const reloadDescriptor = Object.getOwnPropertyDescriptor(proto, "reload");
  const canGoBackDescriptor = Object.getOwnPropertyDescriptor(proto, "canGoBack");
  const canGoForwardDescriptor = Object.getOwnPropertyDescriptor(proto, "canGoForward");
  if (options.loadURL) {
    Object.defineProperty(proto, "loadURL", {
      configurable: true,
      value: options.loadURL,
    });
  }
  if (options.getURL) {
    Object.defineProperty(proto, "getURL", {
      configurable: true,
      value: options.getURL,
    });
  }
  Object.defineProperty(proto, "getWebContentsId", {
    configurable: true,
    value: options.getWebContentsId ?? (() => 1),
  });
  if (options.reload) {
    Object.defineProperty(proto, "reload", {
      configurable: true,
      value: options.reload,
    });
  }
  Object.defineProperty(proto, "canGoBack", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(proto, "canGoForward", {
    configurable: true,
    value: () => false,
  });

  return () => {
    if (loadURLDescriptor) {
      Object.defineProperty(proto, "loadURL", loadURLDescriptor);
    } else {
      delete proto.loadURL;
    }
    if (getURLDescriptor) {
      Object.defineProperty(proto, "getURL", getURLDescriptor);
    } else {
      delete proto.getURL;
    }
    if (getWebContentsIdDescriptor) {
      Object.defineProperty(proto, "getWebContentsId", getWebContentsIdDescriptor);
    } else {
      delete proto.getWebContentsId;
    }
    if (reloadDescriptor) {
      Object.defineProperty(proto, "reload", reloadDescriptor);
    } else {
      delete proto.reload;
    }
    if (canGoBackDescriptor) {
      Object.defineProperty(proto, "canGoBack", canGoBackDescriptor);
    } else {
      delete proto.canGoBack;
    }
    if (canGoForwardDescriptor) {
      Object.defineProperty(proto, "canGoForward", canGoForwardDescriptor);
    } else {
      delete proto.canGoForward;
    }
  };
}

function installDraftAnnotation(overrides: Record<string, unknown> = {}) {
  usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
  usePreviewAnnotationStore.getState().setDraft("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
    threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pageIdentity: "",
    bounds: { x: 20, y: 24, width: 120, height: 32 },
    selectorHint: "button",
    label: "button",
    pageContext: {
      schemaVersion: 2,
      pageUrl: "https://example.com",
      pageTitle: "Example",
      capturedAt: "2026-07-01T00:00:00.000Z",
      captureKind: "element",
      bounds: { x: 20, y: 24, width: 120, height: 32 },
      layoutViewport: { width: 800, height: 600 },
    },
    note: "",
    ...overrides,
  });
}

function installSavedAnnotation(
  overrides: Record<string, unknown> = {},
) {
  const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
  const annotation = {
    threadId,
    pageIdentity: normalizePreviewPageIdentity(pageUrl),
    bounds: { x: 20, y: 24, width: 120, height: 32 },
    selectorHint: "button",
    label: "button",
    pageContext: {
      schemaVersion: 2,
      pageUrl,
      pageTitle: "Example",
      capturedAt: "2026-07-01T00:00:00.000Z",
      captureKind: "element",
      bounds: { x: 20, y: 24, width: 120, height: 32 },
      layoutViewport: { width: 800, height: 600 },
    },
    note: "Move this button",
    ...overrides,
  } as PreviewDraftAnnotation;
  useComposerDraftStore.getState().updateNextMessage(threadId, (draft) => saveBrowserNote(
    draft,
    {
      pageIdentity: annotation.pageIdentity,
      url: pageUrl,
      title: "Example",
      faviconUrl: null,
      capture: annotation.pageContext,
      scroll: { x: 0, y: 0 },
      cleanCapture: null,
    },
    toBrowserNoteContent(annotation),
  ));
}

describe("PreviewPanel: unavailable state", () => {
  beforeEach(() => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
    // Ensure no desktopBridge is present.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
  });

  afterEach(() => {
    browserSurfaceHost.disposeAll();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    mockUsePreviewBridge.mockClear();
    vi.unstubAllEnvs();
    useDiffStore.setState({ previewUrlByThread: {} });
  });

  it("renders the unavailable state when desktopBridge is absent", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(
      screen.getByTestId("preview-panel-unavailable"),
    ).toBeInTheDocument();
  });

  it("does not render the full panel when desktopBridge is absent", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.queryByTestId("preview-panel")).not.toBeInTheDocument();
  });

  it("renders the enabled same-origin web preview without an Electron bridge", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({ previewUrlByThread: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": window.location.origin + "/fixture" } });
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.getByTestId("web-runtime-preview-iframe")).toHaveAttribute(
      "src",
      window.location.origin + "/fixture",
    );
    expect(screen.queryByTestId("web-runtime-cross-origin")).not.toBeInTheDocument();
  });

  it("paints the agent overlay over the web preview while the agent acts", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const key = browserAutomationTargetKey(threadId, threadId, "web-preview");
    useDiffStore.setState({ previewUrlByThread: { [threadId]: window.location.origin + "/fixture" } });
    useBrowserAutomationStore.setState({
      controllers: new Map([[key, { tabId: "web-preview", controller: "agent", controlEpoch: 1, pointer: { x: 40, y: 50 } }]]),
      actingTargets: new Set([key]),
    });
    try {
      render(<PreviewPanel threadId={threadId} coveredRight={112} />);
      expect(screen.getByTestId("browser-acting-overlay")).toHaveStyle({ clipPath: "inset(0 112px 0 0)" });
      expect(screen.getByTestId("browser-automation-pointer")).toHaveStyle({ left: "40px", top: "50px" });
    } finally {
      useBrowserAutomationStore.setState({ controllers: new Map(), actingTargets: new Set() });
    }
  });

  it("publishes the web preview target identity used by the executor", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    useDiffStore.setState({ previewUrlByThread: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": window.location.origin + "/fixture" } });
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    expect(iframe).toHaveAttribute("data-thread-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(iframe).toHaveAttribute("data-tab-id", "web-preview");
    expect(useBrowserAutomationStore.getState().liveTargets.get(
      JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
    )).toMatchObject({ workspaceId: "11111111-1111-4111-8111-111111111111", threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tabId: "web-preview" });
    const initialRevision = useBrowserAutomationStore.getState().liveTargets.get(
      JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
    )!.revision;
    fireEvent.load(iframe);
    expect(useBrowserAutomationStore.getState().liveTargets.get(
      JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
    )!.revision).toBe(initialRevision + 1);
    const page = document.implementation.createHTMLDocument("Fixture");
    page.body.innerHTML = "<main>Visible fixture</main>";
    Object.defineProperty(iframe, "contentDocument", { configurable: true, value: page });
    const result = await executeWebBrowserDispatch({
      scope: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        providerSessionId: "session-1",
        providerInstanceId: "instance-1",
      },
      connection: {
        desktopInstanceId: "web",
        windowId: 1,
        connectionGeneration: 1,
        targetGeneration: 1,
      },
      request: {
        contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        providerSessionId: "session-1",
        providerInstanceId: "instance-1",
        requestId: "request-preview",
        sequence: 1,
        deadline: Date.now() + 1_000,
        expectedControlEpoch: 0,
        operation: "snapshot",
        args: { includeScreenshot: false },
      },
      target: {
        desktopInstanceId: "web",
        windowId: 1,
        connectionGeneration: 1,
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tabId: "web-preview",
        targetGeneration: 1,
        active: true,
        focused: true,
        lastUsedAt: Date.now(),
      },
    } satisfies BrowserAutomationHostDispatch, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, result: { operation: "snapshot" } });
    rect.mockRestore();
  });

  it("switches thread presentation without replacing the prior warm iframe", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({
      previewUrlByThread: {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": window.location.origin + "/first",
        "thread-2": window.location.origin + "/second",
      },
    });
    const view = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const firstIframe = screen.getByTestId("web-runtime-preview-iframe");
    view.rerender(<PreviewPanel threadId="thread-2" />);
    expect(screen.getByLabelText("Preview URL")).toHaveValue(window.location.origin + "/second");
    const secondIframe = screen.getAllByTestId("web-runtime-preview-iframe").find(
      (iframe) => iframe.getAttribute("data-thread-id") === "thread-2",
    );
    expect(secondIframe).toHaveAttribute(
      "src",
      window.location.origin + "/second",
    );
    expect(firstIframe).toBeInTheDocument();
    expect(firstIframe).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps a cross-origin page visible while identifying DOM automation as unsupported", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({ previewUrlByThread: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "https://example.com/fixture" } });
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.getByTestId("web-runtime-preview-iframe")).toBeInTheDocument();
    expect(screen.getByTestId("web-runtime-cross-origin")).toHaveTextContent(
      "automation and DOM access are unsupported",
    );
  });

  it("marks a same-origin requested page unsupported after cross-origin iframe navigation", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    useDiffStore.setState({ previewUrlByThread: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": window.location.origin + "/fixture" } });
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      value: { location: { origin: "https://example.com" } },
    });
    fireEvent.load(iframe);
    await waitFor(() => {
      expect(screen.getByTestId("web-runtime-cross-origin")).toHaveTextContent(
        "automation and DOM access are unsupported",
      );
    });
  });

  it("explains that web preview automation is disabled by default", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "0");
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.getByTestId("preview-panel-unavailable")).toHaveTextContent(
      "Web preview automation is disabled",
    );
    expect(screen.queryByTestId("web-runtime-preview-iframe")).not.toBeInTheDocument();
  });

  it("renders the deterministic same-origin fixture when web automation is enabled", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.queryByTestId("preview-panel-unavailable")).not.toBeInTheDocument();
    expect(screen.getByTestId("web-runtime-preview-iframe")).toHaveAttribute(
      "src",
      `${window.location.origin}/browser-automation-fixture.html`,
    );
  });

  it("hides the hosted iframe when navigation becomes unavailable", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    const input = screen.getByLabelText("Preview URL");

    fireEvent.change(input, { target: { value: "ftp://example.com" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(screen.getByTestId("web-runtime-unavailable")).toBeInTheDocument();
    await waitFor(() => {
      expect(iframe).toBeInTheDocument();
      expect(iframe).toHaveAttribute("aria-hidden", "true");
      expect(iframe).toHaveStyle({ visibility: "hidden" });
    });
  });

  it("shows the new page in the web runtime when no target is loaded", () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const input = screen.getByLabelText("Preview URL");

    fireEvent.change(input, { target: { value: "ftp://example.com" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(within(screen.getByTestId("web-runtime-unavailable")).getByTestId("browser-new-page")).toBeInTheDocument();
  });

  it("hides and restores a warm web runtime panel from explicit presentation visibility", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    const view = render(
      <PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" presentationActive />,
    );
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    expect(iframe).toHaveStyle({ visibility: "visible", pointerEvents: "auto" });
    expect(iframe).toHaveAttribute("aria-hidden", "false");

    view.rerender(
      <PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" presentationActive={false} />,
    );
    await waitFor(() => {
      expect(iframe).toHaveStyle({ visibility: "hidden", pointerEvents: "none" });
      expect(iframe).toHaveAttribute("aria-hidden", "true");
    });

    view.rerender(
      <PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" presentationActive />,
    );
    await waitFor(() => {
      expect(iframe).toHaveStyle({ visibility: "visible", pointerEvents: "auto" });
      expect(iframe).toHaveAttribute("aria-hidden", "false");
    });
    rect.mockRestore();
  });

  // Drives several menus with userEvent (about 1s locally); a loaded CI runner pushed it past the 5s default.
  it("keeps the responsive toolbar available through the web Browser More menu", { timeout: 15_000 }, async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const user = userEvent.setup();
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);

    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().viewportCoordinators.size).toBeGreaterThan(0);
    });
    const iframe = screen.getByTestId("web-runtime-preview-iframe");
    await user.click(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "Device toolbar" }));

    const toolbar = await screen.findByTestId("browser-device-row");
    expect(toolbar).toBeInTheDocument();
    await user.click(within(toolbar).getByRole("button", { name: "Viewport preset" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: "Responsive" }));
    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
        ),
      ).toMatchObject({ mode: "responsive" });
    });
    expect(screen.getByTestId("web-runtime-preview-iframe")).toBe(iframe);

    await user.click(within(toolbar).getByRole("button", { name: "Close viewport toolbar" }));
    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
        ),
      ).toMatchObject({ mode: "regular" });
    });
    expect(screen.queryByTestId("browser-device-row")).not.toBeInTheDocument();
    expect(screen.getByTestId("web-runtime-preview-iframe")).toBe(iframe);
  });

  // Drives several menus with userEvent (about 1s locally); a loaded CI runner pushed it past the 5s default.
  it("opens the toolbar in Fit presentation after a previous fixed zoom", { timeout: 15_000 }, async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    const user = userEvent.setup();
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);

    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().viewportCoordinators.size).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(within(await screen.findByRole("menu")).getByRole(
      "menuitem",
      { name: "Device toolbar" },
    ));
    let toolbar = await screen.findByTestId("browser-device-row");
    await user.click(within(toolbar).getByRole("button", { name: "Viewport scale and presentation" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: "150%" }));
    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
        ),
      ).toMatchObject({ presentation: "150%" });
    });

    await user.click(within(toolbar).getByRole("button", { name: "Close viewport toolbar" }));
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(within(await screen.findByRole("menu")).getByRole(
      "menuitem",
      { name: "Device toolbar" },
    ));
    toolbar = await screen.findByTestId("browser-device-row");

    await waitFor(() => {
      expect(
        useBrowserAutomationStore.getState().viewportStateByTarget.get(
          JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
        ),
      ).toMatchObject({ mode: "responsive", presentation: "fit" });
    });
    expect(within(toolbar).getByRole("button", { name: "Viewport preset" })).toHaveTextContent("Responsive");
  });

  it("shows the responsive toolbar when the agent resizes the viewport", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);

    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().viewportCoordinators.size).toBeGreaterThan(0);
    });
    const coordinator = useBrowserAutomationStore.getState().viewportCoordinators.get(
      JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]),
    );
    expect(coordinator).toBeDefined();
    await coordinator!.requestAgentResize({ width: 393, height: 852 });

    expect(await screen.findByTestId("browser-device-row")).toBeInTheDocument();
  });

  it("shows the toolbar from live agent state before the stored viewport projection catches up", async () => {
    vi.stubEnv("VITE_MCODE_WEB_AUTOMATION", "1");
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);

    const targetKey = JSON.stringify(["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "web-preview"]);
    await waitFor(() => {
      expect(useBrowserAutomationStore.getState().liveTargets.has(targetKey)).toBe(true);
    });
    const targetGeneration = useBrowserAutomationStore.getState().liveTargets.get(targetKey)!.revision;
    const coordinator = new ViewportCoordinator({
      apply: async (operation) => ({ status: "applied", applied: operation.requested }),
      initial: { width: 1280, height: 800 },
      targetGeneration,
    });
    act(() => {
      useBrowserAutomationStore.getState().setViewportCoordinator(
        "11111111-1111-4111-8111-111111111111",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "web-preview",
        coordinator,
      );
    });

    await act(async () => {
      await coordinator.requestAgentResize({ width: 393, height: 852 });
    });

    expect(screen.getByRole("separator", { name: "Resize viewport from right" })).toBeInTheDocument();
    expect(screen.getByTestId("browser-device-row")).toBeInTheDocument();
  });
});

describe("PreviewPanel: full panel state", () => {
  beforeEach(() => {
    // Some panel descendants observe layout via ResizeObserver; jsdom lacks it.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // SlashCommandTray calls scrollIntoView on focused list items; jsdom
    // doesn't implement it, so we stub the prototype once per test rather than
    // per-element. The stub is a no-op; the scroll behaviour is visual only
    // and is covered by e2e tests.
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = {
      preview: {
        sync: vi.fn().mockResolvedValue(undefined),
        navigate: vi.fn().mockResolvedValue({ ok: true }),
        goBack: vi.fn().mockResolvedValue(undefined),
        goForward: vi.fn().mockResolvedValue(undefined),
        reload: vi.fn().mockResolvedValue(undefined),
        openExternal: vi.fn().mockResolvedValue(undefined),
        getNavigationState: vi
          .fn()
          .mockResolvedValue({ canGoBack: false, canGoForward: false }),
        onPageStatus: vi.fn().mockReturnValue(() => {}),
        cancelCapture: vi.fn().mockResolvedValue(undefined),
        surface: {
          prepare: vi.fn().mockResolvedValue({ ok: true }),
          adopt: vi.fn().mockResolvedValue({ ok: true }),
          release: vi.fn().mockResolvedValue({ ok: true }),
          hidden: vi.fn().mockResolvedValue({ ok: true }),
          navigate: vi.fn().mockResolvedValue({ ok: true }),
        },
        design: {
          setAnnotationGuard: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    };
    mockOnAddElementAnnotation.mockResolvedValue({ ok: true });
    mockCaptureSuccess.current = undefined;
    mockCaptureCleanPage.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      scroll: { x: 0, y: 0 },
      capture: {
        schemaVersion: 2,
        pageUrl: "https://example.com",
        pageTitle: "Example",
        capturedAt: "2026-07-01T00:00:00.000Z",
        captureKind: "element",
        bounds: { x: 20, y: 24, width: 120, height: 32 },
        layoutViewport: { width: 800, height: 600 },
      },
    });
    useSettingsStore.getState()._applyPush(getDefaultSettings());
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
    usePreviewDesignModeStore.setState({ pickers: {} });
    usePreviewPageScrollStore.setState({ byTab: {} });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {}, pendingNavErrorsByScope: {} });
    useDiffStore.setState({ previewUrlByThread: {} });
    useBrowserAutomationStore.setState({ controllers: new Map(), pendingAgentOpens: new Map() });
    useProviderCatalogStore.getState().reset();
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
    mockUsePreviewTabs.mockReturnValue({
      tabSet: null,
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
  });

  afterEach(() => {
    browserSurfaceHost.disposeAll();
    vi.unstubAllGlobals();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).desktopBridge = undefined;
    useSettingsStore.getState()._applyPush(getDefaultSettings());
    usePreviewAnnotationStore.setState({ byThread: {}, pages: {}, drafts: {} });
    useComposerDraftStore.setState({ drafts: {} });
    usePreviewDesignModeStore.setState({ pickers: {} });
    usePreviewPageScrollStore.setState({ byTab: {} });
    usePreviewTabsStore.setState({ tabSetByScope: {}, liveChromeByScope: {}, persistentTabIdsByScope: {}, pendingNavErrorsByScope: {} });
    useBrowserAutomationStore.setState({ controllers: new Map(), pendingAgentOpens: new Map() });
    useProviderCatalogStore.getState().reset();
    mockUsePreviewBridge.mockClear();
    mockUsePreviewTabs.mockClear();
    mockOnAddElementAnnotation.mockClear();
    mockCaptureCleanPage.mockClear();
    mockSchedulePageSnapshot.mockClear();
  });

  it("renders the full panel when desktopBridge is present", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
  });

  it("shows the capture confirmation after a successful viewport capture", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    act(() => {
      mockCaptureSuccess.current?.("viewport");
    });

    const confirmation = screen.getByTestId("preview-capture-confirmation");
    expect(within(confirmation).getByText("attached")).toBeInTheDocument();
    expect(within(confirmation).getByText("screenshot")).toBeInTheDocument();
  });

  it("uses an amber shadow and edge wash while the agent controls Browser", () => {
    useBrowserAutomationStore.setState({
      controllers: new Map([
        [
          browserAutomationTargetKey(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
          ),
          {
            tabId: PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
            controller: "agent",
            controlEpoch: 1,
          },
        ],
      ]),
      actingTargets: new Set([
        browserAutomationTargetKey(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
        ),
      ]),
    });

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" coveredRight={112} />);

    const overlay = screen.getByTestId("browser-acting-overlay");
    expect(overlay.parentElement).toBe(screen.getByTestId("preview-surface"));
    expect(overlay).toHaveStyle({ clipPath: "inset(0 112px 0 0)" });
  });

  it("shows the agent frame and cursor while the active page is still opening", () => {
    useBrowserAutomationStore.setState({
      pendingAgentOpens: new Map([
        [
          "pending-open",
          {
            workspaceId: "11111111-1111-4111-8111-111111111111",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            tabId: PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
            url: "https://example.com",
            startedAt: 1,
          },
        ],
      ]),
    });

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);

    expect(screen.getByTestId("browser-acting-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("browser-automation-pointer")).toBeInTheDocument();
  });

  it("paints no agent overlay while the agent holds the page but is idle", () => {
    useBrowserAutomationStore.setState({
      actingTargets: new Set(),
      pendingAgentOpens: new Map(),
      controllers: new Map([
        [
          browserAutomationTargetKey(
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            PREVIEW_WEBVIEW_FALLBACK_TAB_ID,
          ),
          { tabId: PREVIEW_WEBVIEW_FALLBACK_TAB_ID, controller: "agent", controlEpoch: 1 },
        ],
      ]),
    });

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(screen.queryByTestId("browser-acting-overlay")).not.toBeInTheDocument();
  });

  it("does not render the unavailable state when desktopBridge is present", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(
      screen.queryByTestId("preview-panel-unavailable"),
    ).not.toBeInTheDocument();
  });

  it("renders the omnibox URL input inside the full panel", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.getByLabelText("Preview URL")).toBeInTheDocument();
  });

  it("offers no navigation until a page is loaded", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.queryByLabelText("Back")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Forward")).not.toBeInTheDocument();
  });

  it("shows the new page when no page is loaded", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.getByTestId("browser-new-page")).toBeInTheDocument();
  });

  it("accepts an optional workspaceId prop without error", () => {
    expect(() =>
      render(
        <PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="ws-abc" />,
      ),
    ).not.toThrow();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
  });

  it("no longer renders a horizontal tab strip (the rail is the page switcher)", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.queryByTestId("preview-tab-bar")).not.toBeInTheDocument();
  });

  it("uses the webview preview path by default", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.queryByTestId("preview-webview-surface")).not.toBeInTheDocument();
    expect(screen.queryByTestId("preview-webview")).not.toBeInTheDocument();
    expect(screen.getByTestId("browser-new-page")).toBeInTheDocument();
    expect(screen.getByTestId("browser-chrome")).toContainElement(screen.getByTestId("browser-toolbar"));
    expect(mockUsePreviewBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    );
  });

  it("clips the Browser chrome around the expanded activity rail", () => {
    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" coveredRight={112} />);

    expect(screen.getByTestId("browser-chrome")).toHaveStyle({
      clipPath: "inset(0 112px 0 0)",
    });
  });

  it("mounts a blank Electron surface for a new page", async () => {
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "blank-tab",
        tabs: [
          {
            id: "blank-tab",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "New page",
            url: null,
            faviconUrl: null,
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 640, 480),
    );
    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      expect(screen.getByTestId("preview-webview")).toHaveAttribute(
        "data-tab-id",
        "blank-tab",
      );
      expect(
        (await screen.findByTestId("electron-browser-surface-webview")).getAttribute("src"),
      ).toMatch(/^about:blank/);
      expect(screen.getByTestId("browser-new-page")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("electron-browser-surface-webview")).toHaveStyle({
        visibility: "hidden",
        pointerEvents: "none",
      }));
    } finally {
      rect.mockRestore();
    }
  });

  it("renders the active URL in a live webview when the effective engine is webview", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );

    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 640, 480),
    );
    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      const webview = screen.getByTestId("preview-webview");
      expect(webview).toHaveAttribute("data-tab-id", PREVIEW_WEBVIEW_FALLBACK_TAB_ID);
      expect(webview).toHaveAttribute("src", "https://example.com");
      expect(screen.getByTestId("preview-panel")).toHaveClass("pointer-events-none");
      expect(screen.getByTestId("preview-surface")).toHaveClass("pointer-events-none");
      expect(screen.queryByTestId("browser-new-page")).not.toBeInTheDocument();
      expect(await screen.findByTestId("electron-browser-surface-webview")).toHaveStyle({
        visibility: "visible",
        pointerEvents: "auto",
      });
      expect(mockUsePreviewBridge).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      );
    } finally {
      rect.mockRestore();
    }
  });

  it("reloads the current local webview after a matching workspace file change", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "http://127.0.0.1:4173/index.html" }),
    );
    const navigateSurface = vi.mocked(window.desktopBridge!.preview!.surface.navigate);

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);
    await screen.findByTestId("preview-webview");
    await waitFor(() => expect(pushEmitter.channels()).toContain("files.changed"));

    act(() => {
      pushEmitter.emit("files.changed", {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        changedPaths: ["src/main.ts"],
        wholeWorkspace: false,
      });
    });

    expect(navigateSurface).toHaveBeenCalledWith(expect.objectContaining({
      navigation: { kind: "reload" },
    }));
  });

  it("reloads the current local webview when a turn persists file changes", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "http://127.0.0.1:4173/index.html" }),
    );
    const navigateSurface = vi.mocked(window.desktopBridge!.preview!.surface.navigate);

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);
    await screen.findByTestId("preview-webview");
    await waitFor(() => expect(pushEmitter.channels()).toContain("turn.persisted"));

    act(() => {
      pushEmitter.emit("turn.persisted", {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        messageId: "message-1",
        settledMessage: { id: "message-1", sequence: 1 },
        toolCallCount: 1,
        filesChanged: ["src/main.ts"],
      });
    });

    expect(navigateSurface).toHaveBeenCalledWith(expect.objectContaining({
      navigation: { kind: "reload" },
    }));
  });

  it("does not reload the webview when a persisted turn changed no files", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "http://127.0.0.1:4173/index.html" }),
    );
    const navigateSurface = vi.mocked(window.desktopBridge!.preview!.surface.navigate);

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);
    await screen.findByTestId("preview-webview");
    await waitFor(() => expect(pushEmitter.channels()).toContain("turn.persisted"));
    await waitFor(() => expect(navigateSurface).toHaveBeenCalledWith(expect.objectContaining({
      navigation: { kind: "address", address: "http://127.0.0.1:4173/index.html" },
    })));
    navigateSurface.mockClear();

    act(() => {
      pushEmitter.emit("turn.persisted", {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        messageId: "message-1",
        settledMessage: { id: "message-1", sequence: 1 },
        toolCallCount: 3,
        filesChanged: [],
      });
    });

    expect(navigateSurface).not.toHaveBeenCalled();
  });

  it("does not reload the webview for a file change outside its workspace scope", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "http://localhost:4173/index.html" }),
    );
    const navigateSurface = vi.mocked(window.desktopBridge!.preview!.surface.navigate);

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);
    await screen.findByTestId("preview-webview");
    await waitFor(() => expect(pushEmitter.channels()).toContain("files.changed"));
    await waitFor(() => expect(navigateSurface).toHaveBeenCalledWith(expect.objectContaining({
      navigation: { kind: "address", address: "http://localhost:4173/index.html" },
    })));
    navigateSurface.mockClear();

    act(() => {
      pushEmitter.emit("files.changed", {
        workspaceId: "22222222-2222-4222-8222-222222222222",
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        changedPaths: ["src/main.ts"],
        wholeWorkspace: false,
      });
    });

    expect(navigateSurface).not.toHaveBeenCalled();
  });

  it("does not reload a remote webview after a matching workspace file change", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com/docs" }),
    );
    const navigateSurface = vi.mocked(window.desktopBridge!.preview!.surface.navigate);

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" />);
    await screen.findByTestId("preview-webview");
    await waitFor(() => expect(pushEmitter.channels()).toContain("files.changed"));
    await waitFor(() => expect(navigateSurface).toHaveBeenCalledWith(expect.objectContaining({
      navigation: { kind: "address", address: "https://example.com/docs" },
    })));
    navigateSurface.mockClear();

    act(() => {
      pushEmitter.emit("files.changed", {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        changedPaths: ["src/main.ts"],
        wholeWorkspace: false,
      });
    });

    expect(navigateSurface).not.toHaveBeenCalled();
  });

  it("keeps an about:blank live tab stable while the persisted URL is empty", async () => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ storedUrl: "" }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "blank-tab",
        tabs: [{
          id: "blank-tab",
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          title: null,
          url: "about:blank",
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "about:blank",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      const firstWebview = await screen.findByTestId("preview-webview");
      expect(firstWebview).toHaveAttribute("data-tab-id", "blank-tab");
      fireEvent(firstWebview, new Event("did-stop-loading"));
      view.rerender(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      await waitFor(() => expect(screen.getByTestId("preview-webview")).toBe(firstWebview));
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
        "Maximum update depth exceeded",
      );
      view.unmount();
    } finally {
      consoleError.mockRestore();
      restoreWebviewMethods();
    }
  });

  it("preserves a page for a title-only event and clears it on authoritative blank navigation", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );
    useDiffStore.setState({
      previewUrlByThread: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "https://example.com" },
    });
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "about:blank",
    });

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      await screen.findByTestId("preview-webview");
      const hostedWebview = screen.getByTestId("electron-browser-surface-webview");
      fireEvent(hostedWebview, new Event("did-start-loading"));
      expect(useDiffStore.getState().previewUrlByThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]).toBe(
        "https://example.com/",
      );

      const titleEvent = new Event("page-title-updated") as Event & { title?: string };
      Object.defineProperty(titleEvent, "title", { value: "Example" });
      fireEvent(hostedWebview, titleEvent);
      expect(useDiffStore.getState().previewUrlByThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]).toBe(
        "https://example.com/",
      );

      const blankEvent = new Event("did-navigate") as Event & { url?: string };
      Object.defineProperty(blankEvent, "url", { value: "about:blank" });
      fireEvent(hostedWebview, blankEvent);
      await waitFor(() => {
        expect(useDiffStore.getState().previewUrlByThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]).toBe("");
      });
    } finally {
      restoreWebviewMethods();
    }
  });

  it("keeps warm webview pages mounted and hydrates chrome while switching the active tab", async () => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ storedUrl: "https://a.example" }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "tab-a",
        tabs: [
          {
            id: "tab-a",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "A",
            url: "https://a.example",
            faviconUrl: "https://a.example/favicon.ico",
            warm: true,
            active: true,
          },
          {
            id: "tab-b",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "B",
            url: "https://b.example",
            faviconUrl: "https://b.example/favicon.ico",
            warm: true,
            active: false,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    const { rerender } = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    expect(screen.getAllByTestId("preview-webview")).toHaveLength(2);
    const webviewSurface = screen.getByTestId("preview-webview-surface");
    expect(webviewSurface).toHaveClass("pointer-events-none");
    expect(webviewSurface).toContainElement(
      screen.getAllByTestId("preview-webview")[0]!,
    );

    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "tab-b",
        tabs: [
          {
            id: "tab-a",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "A",
            url: "https://a.example",
            faviconUrl: "https://a.example/favicon.ico",
            warm: true,
            active: false,
          },
          {
            id: "tab-b",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: "B",
            url: "https://b.example",
            faviconUrl: "https://b.example/favicon.ico",
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    rerender(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const webviews = screen.getAllByTestId("preview-webview");
    expect(webviews).toHaveLength(2);
    expect(webviews.map((node) => node.getAttribute("data-tab-id"))).toEqual([
      "tab-a",
      "tab-b",
    ]);
    expect(webviews[0]).toHaveAttribute("src", "https://a.example");
    expect(webviews[1]).toHaveAttribute("src", "https://b.example");
    const omnibox = screen.getByLabelText("Preview URL");
    await waitFor(() => expect(omnibox).toHaveValue("https://b.example"));
  });

  it("presents every warm tab in the hidden automation host", async () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      left: 0,
      width: 1280,
      height: 720,
      toJSON: () => ({}),
    });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ storedUrl: "https://a.example" }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "tab-a",
        tabs: [
          { id: "tab-a", threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "A", url: "https://a.example", faviconUrl: null, warm: true, active: true },
          { id: "tab-b", threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "B", url: "https://b.example", faviconUrl: null, warm: true, active: false },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" workspaceId="11111111-1111-4111-8111-111111111111" automationOnly />);

    await waitFor(() => expect(screen.getAllByTestId("electron-browser-surface-webview")).toHaveLength(2));
    expect(screen.getAllByTestId("electron-browser-surface-webview")).toEqual([
      expect.objectContaining({ style: expect.objectContaining({ visibility: "visible" }) }),
      expect.objectContaining({ style: expect.objectContaining({ visibility: "visible" }) }),
    ]);
    bounds.mockRestore();
  });

  it("persists favicon updates from inactive warm webview pages", async () => {
    const tabSet = {
      threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      activeTabId: "tab-a",
      tabs: [
        {
          id: "tab-a",
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          title: "A",
          url: "https://a.example",
          faviconUrl: null,
          warm: true,
          active: true,
        },
        {
          id: "tab-b",
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          title: "B",
          url: "https://b.example",
          faviconUrl: null,
          warm: true,
          active: false,
        },
      ],
    };
    usePreviewTabsStore.getState().setTabSet("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tabSet);
    mockUsePreviewTabs.mockReturnValue({
      tabSet,
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const inactiveWebview = (await screen.findAllByTestId("electron-browser-surface-webview"))
      .find((node) => node.getAttribute("data-tab-id") === "tab-b")!;
    fireEvent(
      inactiveWebview,
      Object.assign(new Event("page-favicon-updated"), {
        favicons: ["https://b.example/favicon.ico"],
      }),
    );

    await waitFor(() => {
      const updatedTabSet = usePreviewTabsStore.getState().tabSetByScope[previewTabsScopeKey("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")]!;
      expect(updatedTabSet.tabs.find((tab) => tab.id === "tab-b")?.faviconUrl).toBe(
        "https://b.example/favicon.ico",
      );
    });
  });

  it("does not loop when equivalent active webview tab data is republished", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "https://a.example",
    });
    const setEquivalentTabs = () => {
      mockUsePreviewTabs.mockReturnValue({
        tabSet: {
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          activeTabId: "tab-a",
          tabs: [
            {
              id: "tab-a",
              threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              title: "A",
              url: "https://a.example",
              faviconUrl: null,
              warm: true,
              active: true,
            },
          ],
        },
        newTab: vi.fn(),
        activateTab: vi.fn(),
        closeTab: vi.fn(),
      });
    };

    try {
      setEquivalentTabs();
      const { rerender } = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      setEquivalentTabs();
      rerender(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      setEquivalentTabs();
      rerender(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      expect(screen.getByTestId("preview-webview")).toHaveAttribute(
        "src",
        "https://a.example",
      );
      expect(consoleError).not.toHaveBeenCalledWith(
        expect.stringContaining("Maximum update depth exceeded"),
      );
    } finally {
      restoreWebviewMethods();
      consoleError.mockRestore();
    }
  });

  it("navigates changed webview URLs through src without an extra loadURL call", async () => {
    const resolveNavigation = vi
      .fn()
      .mockResolvedValue({ ok: true, url: "https://about.google/" });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        storedUrl: "https://google.com/",
        resolveNavigation,
      }),
    );

    const loadURL = vi.fn().mockResolvedValue(undefined);
    const restoreWebviewMethods = installMockWebviewMethods({
      loadURL,
      getURL: () => "https://google.com/",
    });

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://google.com/",
        );
      });
      fireEvent(screen.getByTestId("preview-webview"), new Event("dom-ready"));

      const input = screen.getByLabelText("Preview URL");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "https://about.google/" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

      await waitFor(() => {
        expect(resolveNavigation).toHaveBeenCalledWith("https://about.google/");
      });
      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://about.google/",
        );
      });
      expect(loadURL).not.toHaveBeenCalled();
    } finally {
      restoreWebviewMethods();
    }
  });

  it("does not rewrite src when stored URL already matches the live webview URL", async () => {
    let liveUrl = "https://google.com/";
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => liveUrl,
    });

    try {
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: "https://google.com/" }),
      );
      const { rerender } = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      const webview = screen.getByTestId("preview-webview");
      expect(webview).toHaveAttribute("src", "https://google.com/");

      liveUrl = "https://about.google/";
      fireEvent(
        await screen.findByTestId("electron-browser-surface-webview"),
        Object.assign(new Event("did-navigate"), { url: liveUrl }),
      );
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: "https://about.google/" }),
      );
      rerender(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://google.com/",
        );
      });
    } finally {
      restoreWebviewMethods();
    }
  });

  it("follows a host-assigned URL when a reused tab's earlier request already settled", async () => {
    const tabSetWith = (url: string | null) => ({
      threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      activeTabId: "tab-1",
      tabs: [
        {
          id: "tab-1",
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          title: null,
          url,
          faviconUrl: null,
          warm: true,
          active: true,
        },
      ],
    });
    mockUsePreviewTabs.mockReturnValue({
      tabSet: tabSetWith("https://old.example/"),
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "https://old.example/",
    });

    try {
      const { rerender } = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      await waitFor(() =>
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://old.example/",
        ),
      );
      const hostedWebview = screen.getByTestId("electron-browser-surface-webview");
      const navigated = new Event("did-navigate") as Event & { url?: string };
      Object.defineProperty(navigated, "url", { value: "https://old.example/" });
      fireEvent(hostedWebview, navigated);
      fireEvent(hostedWebview, new Event("did-stop-loading"));

      // Ctrl+click reuses the empty/errored tab: the host rewrites tab.url
      // through tabs.open(initialAddress), observed via preview:tabs-updated.
      mockUsePreviewTabs.mockReturnValue({
        tabSet: tabSetWith("https://new.example/"),
        newTab: vi.fn(),
        activateTab: vi.fn(),
        closeTab: vi.fn(),
      });
      rerender(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      await waitFor(() =>
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          "https://new.example/",
        ),
      );
    } finally {
      restoreWebviewMethods();
    }
  });

  it("keeps one hosted placement mounted while its viewport coordinator registers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const threadId = "thread-adoption-stability";
    const tabId = "tab-adoption-stability";
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId,
        activeTabId: tabId,
        tabs: [
          {
            id: tabId,
            threadId,
            title: "Example",
            url: "https://example.com",
            faviconUrl: null,
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );
    const prepare = vi.mocked(window.desktopBridge!.preview!.surface.prepare);
    const release = vi.mocked(window.desktopBridge!.preview!.surface.release);

    render(<PreviewPanel threadId={threadId} workspaceId="11111111-1111-4111-8111-111111111111" />);
    const initialPlacement = screen.getByTestId("preview-webview");

    await waitFor(() => expect(prepare).toHaveBeenCalled());
    await act(() => vi.advanceTimersByTimeAsync(50));

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-webview")).toBe(initialPlacement);
  });

  it("does not feed an agent navigation redirect back into the webview src", async () => {
    const requestedUrl =
      "https://duckduckgo.com/?q=The+Left+Hand+of+Darkness+Ursula+K.+Le+Guin";
    const redirectedUrl = `${requestedUrl}&ia=web`;
    let liveUrl = requestedUrl;
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => liveUrl,
    });
    const tabs = (url: string) => ({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "agent-tab",
        tabs: [{
          id: "agent-tab",
          threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          title: "DuckDuckGo",
          url,
          faviconUrl: null,
          warm: true,
          active: true,
        }],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });

    try {
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: requestedUrl }),
      );
      mockUsePreviewTabs.mockReturnValue(tabs(requestedUrl));
      const { rerender } = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      const webview = screen.getByTestId("preview-webview");
      expect(webview).toHaveAttribute("src", requestedUrl);

      liveUrl = redirectedUrl;
      fireEvent(
        await screen.findByTestId("electron-browser-surface-webview"),
        Object.assign(new Event("did-navigate"), { url: liveUrl }),
      );
      mockUsePreviewBridge.mockReturnValue(
        mockBridgeState({ storedUrl: redirectedUrl }),
      );
      mockUsePreviewTabs.mockReturnValue(tabs(redirectedUrl));
      rerender(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      await waitFor(() => {
        expect(screen.getByTestId("preview-webview")).toHaveAttribute(
          "src",
          requestedUrl,
        );
      });
    } finally {
      restoreWebviewMethods();
    }
  });

  it("reloads instead of loadURL when navigating to the live webview URL", async () => {
    const resolveNavigation = vi
      .fn()
      .mockResolvedValue({ ok: true, url: "https://google.com/" });
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        storedUrl: "https://google.com/",
        resolveNavigation,
      }),
    );

    const loadURL = vi.fn().mockResolvedValue(undefined);
    const navigateSurface = vi.mocked(window.desktopBridge!.preview!.surface.navigate);
    const restoreWebviewMethods = installMockWebviewMethods({
      loadURL,
      getURL: () => "https://google.com/",
    });

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      const input = screen.getByLabelText("Preview URL");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "https://google.com/" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

      await waitFor(() => {
        expect(resolveNavigation).toHaveBeenCalledWith("https://google.com/");
      });
      await waitFor(() => {
        expect(navigateSurface).toHaveBeenCalledWith(expect.objectContaining({
          navigation: { kind: "reload" },
        }));
      });
      expect(loadURL).not.toHaveBeenCalled();
    } finally {
      restoreWebviewMethods();
    }
  });

  it("keeps the live webview mounted while the More menu is open", async () => {
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({ storedUrl: "https://example.com" }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(screen.getByTestId("preview-webview")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("More"));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByTestId("preview-webview")).toBeInTheDocument();
  });

  it("keeps browser chrome visible while design mode has no saved annotations", () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: "https://example.com/product-preview?productCode=QUAELE2010",
        storedUrl: "https://example.com/product-preview?productCode=QUAELE2010",
        pageStatus: {
          url: "https://example.com/product-preview?productCode=QUAELE2010",
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(screen.getByTestId("browser-toolbar")).toBeInTheDocument();
    expect(
      screen.queryByTestId("preview-annotation-header"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("preview-annotation-send-state"),
    ).not.toBeInTheDocument();
    const designButton = screen.getByRole("button", { name: "Design" });
    expect(designButton).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the browser toolbar in place once a note is saved", () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    installSavedAnnotation();
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(screen.getByTestId("browser-toolbar")).toBeInTheDocument();
    expect(screen.queryByTestId("preview-annotation-header")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit annotation 1" })).toBeInTheDocument();
  });

  it("anchors a marker on the element's top-left corner and keeps it there while the page scrolls", () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    installSavedAnnotation();
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const marker = screen.getByRole("button", { name: "Edit annotation 1" });
    const outline = screen.getByTestId("preview-annotation-outline");
    expect(marker).toHaveStyle({ left: "10px", top: "14px" });
    expect(outline).toHaveStyle({ left: "20px", top: "24px", width: "120px", height: "32px" });

    act(() => {
      usePreviewPageScrollStore
        .getState()
        .report("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", PREVIEW_WEBVIEW_FALLBACK_TAB_ID, { x: 5, y: 100 });
    });

    expect(marker).toHaveStyle({ left: "5px", top: "-86px" });
    expect(outline).toHaveStyle({ left: "15px", top: "-76px" });
  });

  it("treats the scroll position at capture time as the origin of the marker", () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    installSavedAnnotation({
      pageContext: {
        schemaVersion: 2,
        pageUrl: "https://example.com/product-preview?productCode=QUAELE2010",
        pageTitle: "Example",
        capturedAt: "2026-07-01T00:00:00.000Z",
        captureKind: "element",
        bounds: { x: 20, y: 24, width: 120, height: 32 },
        layoutViewport: { width: 800, height: 600 },
        viewportScroll: { scrollX: 0, scrollY: 300 },
      },
    });
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    act(() => {
      usePreviewPageScrollStore
        .getState()
        .report("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", PREVIEW_WEBVIEW_FALLBACK_TAB_ID, { x: 0, y: 250 });
    });

    expect(screen.getByRole("button", { name: "Edit annotation 1" })).toHaveStyle({ top: "64px" });
  });

  it("numbers markers from 1 on each page and hides the markers of other pages", () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    installSavedAnnotation({
      pageIdentity: normalizePreviewPageIdentity("https://example.com/other-page"),
    });
    installSavedAnnotation();
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const markers = screen.getAllByTestId("preview-annotation-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent("1");
    expect(screen.getAllByTestId("preview-annotation-outline")).toHaveLength(1);
  });

  it("hides saved annotation markers when design mode is inactive", () => {
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(usePreviewAnnotationStore.getState().byThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]).toHaveLength(
      1,
    );
    expect(
      screen.queryByRole("button", { name: "Edit annotation 1" }),
    ).not.toBeInTheDocument();
  });

  it("shows saved annotations as numbered markers until reopened", () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const marker = screen.getByRole("button", { name: "Edit annotation 1" });
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveTextContent("1");
    expect(
      screen.queryByTestId("preview-annotation-target-highlight"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("preview-annotation-active-target-highlight"),
    ).not.toBeInTheDocument();

    fireEvent.click(marker);

    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    expect(
      screen.getByTestId("preview-annotation-active-target-highlight"),
    ).toHaveStyle({
      left: "20px",
      top: "24px",
      width: "120px",
      height: "32px",
    });
  });

  it("shows saved annotation content when the marker is hovered", async () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    installSavedAnnotation();
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    await userEvent.hover(screen.getByRole("button", { name: "Edit annotation 1" }));

    expect(await screen.findByText("Move this button")).toBeInTheDocument();
    expect(screen.getByText("button")).toBeInTheDocument();
  });

  it.each(["", "   "])("does not save a blank annotation note %j on Enter", (value) => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value } });
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    expect(screen.queryByTestId("preview-annotation-save")).not.toBeInTheDocument();
    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    expect(usePreviewAnnotationStore.getState().getThreadAnnotations(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )).toEqual([]);
  });

  it("outlines the target while the draft annotation bubble is open", () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(
      screen.getByTestId("preview-annotation-active-target-highlight"),
    ).toHaveStyle({
      left: "20px",
      top: "24px",
      width: "120px",
      height: "32px",
    });
  });

  it("shows annotation save only after note text exists", () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(screen.queryByTestId("preview-annotation-save")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Annotation note"), {
      target: { value: "Needs stronger contrast" },
    });
    expect(screen.getByTestId("preview-annotation-save")).toBeInTheDocument();
  });

  it("shakes before discarding a dirty draft from outside clicks", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    fireEvent.change(screen.getByLabelText("Annotation note"), {
      target: { value: "Needs stronger contrast" },
    });
    fireEvent.pointerDown(screen.getByTestId("preview-surface"));

    await waitFor(() => {
      expect(screen.getByTestId("preview-annotation-bubble")).toHaveClass(
        "animate-preview-annotation-shake",
      );
    });
    expect(
      screen.queryByText("Click outside again to discard"),
    ).not.toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId("preview-annotation-discard-overlay"));

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ).toBeUndefined();
    });
    expect(
      screen.queryByTestId("preview-annotation-bubble"),
    ).not.toBeInTheDocument();
  });

  it("focuses the annotation note when a draft bubble opens", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Annotation note")).toHaveFocus();
    });
  });

  it("closes only the open annotation bubble on Escape", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ).toBeUndefined();
    });
    expect(usePreviewDesignModeStore.getState().isActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
    expect(
      screen.queryByTestId("preview-annotation-bubble"),
    ).not.toBeInTheDocument();
  });

  it("exits design mode on Escape when no annotation bubble is open", async () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(usePreviewDesignModeStore.getState().isActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(false);
    });
    expect(window.desktopBridge?.preview?.cancelCapture).toHaveBeenCalled();
  });

  it("handles app-level Escape without closing design mode when a bubble is open", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const event = new CustomEvent("mcode:preview-design-escape", {
      cancelable: true,
      detail: { threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    const notCancelled = window.dispatchEvent(event);

    expect(notCancelled).toBe(false);
    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ).toBeUndefined();
    });
    expect(usePreviewDesignModeStore.getState().isActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(true);
  });

  it("keeps the open annotation when the rail maximize control is clicked", () => {
    installDraftAnnotation();
    const maximize = document.createElement("button");
    maximize.setAttribute("data-preview-design-keep-open", "true");
    document.body.append(maximize);

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      fireEvent.pointerDown(maximize);

      expect(usePreviewAnnotationStore.getState().drafts["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]).toBeDefined();
      expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    } finally {
      maximize.remove();
    }
  });

  it("discards an unsaved draft when design mode exits from browser chrome", async () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Design" }));

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().drafts["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ).toBeUndefined();
    });
    expect(
      screen.queryByTestId("preview-annotation-bubble"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Design" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("saves the annotation when Enter is pressed in the note", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "Use stronger contrast" } });
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().byThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ).toHaveLength(1);
    });
    expect(mockCaptureCleanPage).toHaveBeenCalledTimes(1);
    expect(mockSchedulePageSnapshot).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "");
    expect(
      usePreviewAnnotationStore.getState().byThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]?.[0]?.note,
    ).toBe("Use stronger contrast");
  });

  it("numbers a second note on the same page after the first and redraws that page", async () => {
    const pageUrl = "https://example.com/product-preview?productCode=QUAELE2010";
    mockUsePreviewBridge.mockReturnValue(
      mockBridgeState({
        inputUrl: pageUrl,
        storedUrl: pageUrl,
        pageStatus: {
          url: pageUrl,
          title: "Example",
          favicon: null,
          phase: "loaded",
        },
      }),
    );
    installSavedAnnotation();
    installDraftAnnotation({
      pageIdentity: normalizePreviewPageIdentity(pageUrl),
      bounds: { x: 200, y: 120, width: 180, height: 44 },
      pageContext: {
        schemaVersion: 2,
        pageUrl,
        pageTitle: "Example",
        capturedAt: "2026-07-01T00:00:00.000Z",
        captureKind: "element",
        bounds: { x: 200, y: 120, width: 180, height: 44 },
        layoutViewport: { width: 800, height: 600 },
      },
    });

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "Move this search input" } });
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(
        usePreviewAnnotationStore.getState().byThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]?.map((note) => note.displayNumber),
      ).toEqual([1, 2]);
    });
    expect(mockSchedulePageSnapshot).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      normalizePreviewPageIdentity(pageUrl),
    );
  });

  it("saves and requests composer send when Ctrl+Enter is pressed", async () => {
    const submitSpy = vi.fn();
    window.addEventListener("mcode:submit-composer", submitSpy);
    installDraftAnnotation();

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      const note = screen.getByLabelText("Annotation note");
      fireEvent.change(note, { target: { value: "Move this button" } });
      fireEvent.keyDown(note, {
        key: "Enter",
        code: "Enter",
        ctrlKey: true,
      });

      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledTimes(1);
      });
      const event = submitSpy.mock.calls[0]?.[0] as CustomEvent<{
        threadId?: string;
      }>;
      expect(event.detail.threadId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    } finally {
      window.removeEventListener("mcode:submit-composer", submitSpy);
    }
  });

  it("guards the page while a design-mode annotation bubble is open", async () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    installDraftAnnotation();

    const { unmount } = render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const setAnnotationGuard = vi.mocked(
      window.desktopBridge!.preview!.design.setAnnotationGuard,
    );
    await waitFor(() => {
      expect(setAnnotationGuard).toHaveBeenCalledWith(true);
    });

    unmount();

    await waitFor(() => {
      expect(setAnnotationGuard).toHaveBeenCalledWith(false);
    });
  });

  it("re-arms the element picker after saving a design-mode annotation", async () => {
    usePreviewDesignModeStore.getState().setActive("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true);
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    expect(mockOnAddElementAnnotation).not.toHaveBeenCalled();
    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "Tighten spacing" } });
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockOnAddElementAnnotation).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Annotation bubble slash-command popup
  // ---------------------------------------------------------------------------

  it("opens the slash-command popup when '/' is typed in the annotation note", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const note = screen.getByLabelText("Annotation note");
    // onChange reads selectionStart ?? value.length; jsdom returns null for
    // selectionStart on a synthetic change event, so it falls back to
    // value.length (1 for "/"). SLASH_TRIGGER_RE matches "/" at cursor 1.
    fireEvent.change(note, { target: { value: "/" } });

    // Skills load is async; wait for the popup to become ready.
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    });
  });

  it("closes the slash-command popup when Escape is pressed in the annotation note", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "/" } });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    });

    // Escape must dismiss the popup without discarding the bubble.
    fireEvent.keyDown(note, { key: "Escape", code: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    });
    // The annotation bubble must remain open after a popup Escape.
    expect(screen.getByTestId("preview-annotation-bubble")).toBeInTheDocument();
  });

  it("inserts the selected command text on Enter and does NOT save the annotation", async () => {
    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "/" } });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    });

    // Enter selects the first item and inserts it as plain text. It must NOT
    // save the annotation (no annotation should be saved to byThread).
    fireEvent.keyDown(note, { key: "Enter", code: "Enter" });

    // The annotation store must still be empty (not saved).
    expect(
      usePreviewAnnotationStore.getState().byThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ).toBeUndefined();
    // The popup must be dismissed after selection.
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    });
  });

  it("does not include builtin mcode commands in the annotation note popup", async () => {
    // Override skills to be empty so only builtins would appear if they were
    // included; with includeBuiltins: false the popup renders the empty state
    // instead of a list. Confirms builtins don't leak into the annotation popup.
    mockGetProviderCatalog.mockResolvedValueOnce({
      providerId: "claude",
      context: { scope: "user" },
      freshness: { status: "fresh", fetchedAt: "2026-07-20T12:00:00.000Z" },
      diagnostics: [],
      entries: [],
      selectableAgents: [],
    });
    useProviderCatalogStore.getState().reset();

    installDraftAnnotation();

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

    const note = screen.getByLabelText("Annotation note");
    fireEvent.change(note, { target: { value: "/" } });

    // With no skills and no builtins, the popup shows the empty state, not a
    // listbox. Builtins (plan, compact, goal) must not appear.
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
      // The popup is still rendered (closed state would remove it entirely) but
      // shows an empty-state status instead of items.
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  it("Ctrl+Enter saves the annotation while the popup is closed", async () => {
    const submitSpy = vi.fn();
    window.addEventListener("mcode:submit-composer", submitSpy);
    installDraftAnnotation();

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);

      const note = screen.getByLabelText("Annotation note");
      fireEvent.change(note, { target: { value: "Use stronger contrast" } });
      // Ctrl+Enter saves when popup is NOT open.
      fireEvent.keyDown(note, { key: "Enter", code: "Enter", ctrlKey: true });

      await waitFor(() => {
        expect(
          usePreviewAnnotationStore.getState().byThread["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        ).toHaveLength(1);
      });
      expect(submitSpy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("mcode:submit-composer", submitSpy);
    }
  });
  it("shows a file-not-found error page when the omnibox path is rejected", async () => {
    const resolveNavigation = vi.fn().mockResolvedValue({ ok: false, error: "file-not-found" });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ resolveNavigation }));

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const input = screen.getByLabelText("Preview URL");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "C:\\missing\\page.html" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("preview-error-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("File not found");
    expect(
      within(screen.getByTestId("preview-error-panel")).getByText(/C:\\missing\\page\.html/),
    ).toBeInTheDocument();
  });

  it("keeps input-shape failures as an inline hint instead of an error page", async () => {
    const resolveNavigation = vi.fn().mockResolvedValue({ ok: false, error: "invalid-url" });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ resolveNavigation }));

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const input = screen.getByLabelText("Preview URL");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "not a url" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("invalid-url"),
    );
    expect(screen.queryByTestId("preview-error-panel")).not.toBeInTheDocument();
  });

  it("shows folder guidance and a detail line for a directory", async () => {
    const resolveNavigation = vi.fn().mockResolvedValue({ ok: false, error: "is-directory" });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ resolveNavigation }));

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const input = screen.getByLabelText("Preview URL");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "C:\\workspace\\docs" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("Can't preview a folder"),
    );
    expect(screen.getByTestId("preview-error-detail")).toHaveTextContent("index.html");
  });

  it("hides Retry on the blocked page for a sensitive file", async () => {
    const resolveNavigation = vi.fn().mockResolvedValue({ ok: false, error: "sensitive-file" });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ resolveNavigation }));

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const input = screen.getByLabelText("Preview URL");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "C:\\workspace\\.env" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(screen.getByTestId("preview-error-headline")).toHaveTextContent("This file can't be previewed"),
    );
    expect(screen.getByTestId("preview-error-detail")).toHaveTextContent(".env");
    expect(screen.queryByTestId("preview-error-retry")).not.toBeInTheDocument();
  });

  it("retries a rejected navigation by re-running resolve with the attempted input", async () => {
    const resolveNavigation = vi.fn().mockResolvedValue({ ok: false, error: "file-not-found" });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ resolveNavigation }));

    render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    const input = screen.getByLabelText("Preview URL");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "C:\\missing\\page.html" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => screen.getByTestId("preview-error-panel"));

    fireEvent.click(screen.getByTestId("preview-error-retry"));

    await waitFor(() => expect(resolveNavigation).toHaveBeenCalledTimes(2));
    expect(resolveNavigation).toHaveBeenLastCalledWith("C:\\missing\\page.html");
  });

  it("keeps the error on republish of the superseded page and clears on a real commit", async () => {
    const resolveNavigation = vi.fn().mockResolvedValue({ ok: false, error: "file-not-found" });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ resolveNavigation }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: null,
            url: "https://old.example/",
            faviconUrl: null,
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "https://old.example/",
    });

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      const hostedWebview = await waitFor(() =>
        screen.getByTestId("electron-browser-surface-webview"),
      );
      fireEvent(hostedWebview, new Event("dom-ready"));
      const oldNav = new Event("did-navigate") as Event & { url?: string };
      Object.defineProperty(oldNav, "url", { value: "https://old.example/" });
      fireEvent(hostedWebview, oldNav);
      fireEvent(hostedWebview, new Event("did-stop-loading"));

      const input = screen.getByLabelText("Preview URL");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "C:\\missing\\page.html" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await waitFor(() => screen.getByTestId("preview-error-panel"));

      // A republish of the page the error replaced must not clear it.
      const republish = new Event("did-navigate") as Event & { url?: string };
      Object.defineProperty(republish, "url", { value: "https://old.example/" });
      fireEvent(hostedWebview, republish);
      expect(screen.getByTestId("preview-error-panel")).toBeInTheDocument();

      const commit = new Event("did-navigate") as Event & { url?: string };
      Object.defineProperty(commit, "url", { value: "https://new.example/" });
      fireEvent(hostedWebview, commit);
      await waitFor(() =>
        expect(screen.queryByTestId("preview-error-panel")).not.toBeInTheDocument(),
      );
    } finally {
      restoreWebviewMethods();
    }
  });

  it("drops a superseded navigation result instead of pinning its error over the live page", async () => {
    let resolveStale!: (v: { ok: false; error: string }) => void;
    const stale = new Promise<{ ok: false; error: string }>((r) => {
      resolveStale = r;
    });
    const resolveNavigation = vi
      .fn()
      .mockReturnValueOnce(stale)
      .mockResolvedValue({ ok: true, url: "https://new.example/" });
    mockUsePreviewBridge.mockReturnValue(mockBridgeState({ resolveNavigation }));
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            title: null,
            url: "https://old.example/",
            faviconUrl: null,
            warm: true,
            active: true,
          },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    const restoreWebviewMethods = installMockWebviewMethods({
      getURL: () => "https://old.example/",
    });

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      const input = screen.getByLabelText("Preview URL");

      // Slow submission that will fail, then a fast one that succeeds.
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "C:\\missing\\page.html" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      fireEvent.change(input, { target: { value: "https://new.example/" } });
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(resolveNavigation).toHaveBeenCalledTimes(2));

      // The stale failure resolves last and must be ignored.
      resolveStale({ ok: false, error: "file-not-found" });
      await waitFor(() =>
        expect(usePreviewTabsStore.getState().pendingNavErrorsByScope).toEqual({}),
      );
      expect(screen.queryByTestId("preview-error-panel")).not.toBeInTheDocument();
    } finally {
      restoreWebviewMethods();
    }
  });

  it("clears a backgrounded tab's pending error when that tab commits", async () => {
    mockUsePreviewBridge.mockReturnValue(mockBridgeState());
    mockUsePreviewTabs.mockReturnValue({
      tabSet: {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        activeTabId: "tab-a",
        tabs: [
          { id: "tab-a", threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: null, url: "https://a.example/", faviconUrl: null, warm: true, active: true },
          { id: "tab-b", threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: null, url: null, faviconUrl: null, warm: true, active: false },
        ],
      },
      newTab: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
    });
    usePreviewTabsStore.getState().setPendingNavError("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tab-b", {
      input: "C:\\missing\\page.html",
      error: { kind: "file-not-found", message: "File not found" },
      supersededUrl: null,
    });
    const restoreWebviewMethods = installMockWebviewMethods({});

    try {
      render(<PreviewPanel threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
      const webviews = await waitFor(() =>
        screen.getAllByTestId("electron-browser-surface-webview"),
      );
      const commit = new Event("did-navigate") as Event & { url?: string };
      Object.defineProperty(commit, "url", { value: "https://b.example/" });
      fireEvent(webviews[1]!, commit);

      await waitFor(() =>
        expect(
          usePreviewTabsStore.getState().pendingNavErrorsByScope[
            previewTabsScopeKey("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
          ],
        ).toBeUndefined(),
      );
    } finally {
      restoreWebviewMethods();
    }
  });
});
