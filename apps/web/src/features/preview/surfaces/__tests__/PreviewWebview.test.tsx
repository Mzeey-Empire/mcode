import { render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserAutomationTargetKey,
  onBrowserAutomationObservationInvalidation,
  releaseBrowserAutomationThreadScope,
  useBrowserAutomationStore,
} from "../../automation/browserAutomationStore";
import type { PreviewPageStatus } from "@mcode/contracts";
import { PreviewWebview, type PreviewWebviewHandle } from "../PreviewWebview";
import {
  browserSurfaceHost,
  browserSurfacePresentationCoordinator,
} from "../BrowserSurfaceHostRoot";

describe("PreviewWebview", () => {
  beforeEach(() => {
    document.querySelectorAll("[data-testid='electron-browser-surface-webview'], [data-testid='web-runtime-preview-iframe']")
      .forEach((element) => element.remove());
  });

  afterEach(() => {
    browserSurfacePresentationCoordinator.setActivityRailOverlap(0);
    browserSurfacePresentationCoordinator.dispose();
    browserSurfaceHost.disposeAll();
    delete window.desktopBridge;
  });

  it("transfers exact tab control and invalidates observations only for trusted guest input", async () => {
    const invalidate = vi.fn();
    const interrupt = vi.fn().mockResolvedValue(true);
    window.desktopBridge = {
      preview: {
        surface: {
          prepare: vi.fn().mockResolvedValue({ ok: true }),
          adopt: vi.fn().mockResolvedValue({ ok: true }),
          navigate: vi.fn().mockResolvedValue({ ok: true }),
          release: vi.fn().mockResolvedValue({ ok: true }),
          hidden: vi.fn().mockResolvedValue({ ok: true }),
        },
        automation: { interrupt },
      },
    } as unknown as NonNullable<typeof window.desktopBridge>;
    const unsubscribe = onBrowserAutomationObservationInvalidation(invalidate);
    render(
      <PreviewWebview
        workspaceId="11111111-1111-4111-8111-111111111111"
        threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        tabId="tab-1"
        src="https://example.com"
      />,
    );
    const webview = await screen.findByTestId("electron-browser-surface-webview");
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "mcode:browser-human-input",
      args: [{ kind: "pointer" }],
    }));
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "mcode:browser-human-input",
      args: [{ kind: "synthetic" }],
    }));
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "mcode:browser-human-input",
      args: [{ kind: "focus" }],
    }));
    webview.dispatchEvent(Object.assign(new Event("ipc-message"), {
      channel: "untrusted-channel",
      args: [{ kind: "pointer" }],
    }));
    unsubscribe();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "tab-1");
    expect(interrupt).toHaveBeenCalledOnce();
    expect(interrupt).toHaveBeenCalledWith({ threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tabId: "tab-1" });
  });

  it("routes history through the exact generation-bound main bridge", async () => {
    const observed: { handle: PreviewWebviewHandle | null } = { handle: null };
    const navigate = vi.fn().mockResolvedValue({ ok: true });
    window.desktopBridge = { preview: { surface: {
      prepare: vi.fn().mockResolvedValue({ ok: true }),
      adopt: vi.fn().mockResolvedValue({ ok: true }),
      navigate,
      release: vi.fn().mockResolvedValue({ ok: true }),
      hidden: vi.fn().mockResolvedValue({ ok: true }),
    } } } as unknown as NonNullable<typeof window.desktopBridge>;

    function Probe() {
      const ref = useRef<PreviewWebviewHandle>(null);
      useEffect(() => {
        observed.handle = ref.current;
        ref.current?.goBack();
      }, []);
      return (
        <PreviewWebview
          ref={ref}
          threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          tabId="tab-1"
          src="https://example.com"
        />
      );
    }

    render(<Probe />);

    await waitFor(() => expect(observed.handle).not.toBeNull());
    expect(navigate).toHaveBeenCalledWith({
      surface: {
        identity: {
          workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          scope: { kind: "thread", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          tabId: "tab-1",
        },
        generation: expect.any(Number),
      },
      navigation: { kind: "back" },
    });
  });

  describe("reload", () => {
    const WORKSPACE = "55555555-5555-4555-8555-555555555555";
    const IDENTITY = { workspaceId: WORKSPACE, scope: { kind: "thread" as const, id: WORKSPACE }, tabId: "tab-reload" };

    async function mountWithBridge(onPageStatus?: (status: PreviewPageStatus) => void) {
      const navigate = vi.fn().mockResolvedValue({ ok: true });
      window.desktopBridge = { preview: { surface: {
        prepare: vi.fn().mockResolvedValue({ ok: true }),
        adopt: vi.fn().mockResolvedValue({ ok: true }),
        navigate,
        release: vi.fn().mockResolvedValue({ ok: true }),
        hidden: vi.fn().mockResolvedValue({ ok: true }),
      } } } as unknown as NonNullable<typeof window.desktopBridge>;
      const observed: { handle: PreviewWebviewHandle | null } = { handle: null };
      function Probe() {
        const ref = useRef<PreviewWebviewHandle>(null);
        useEffect(() => { observed.handle = ref.current; }, []);
        return <PreviewWebview ref={ref} threadId={WORKSPACE} tabId="tab-reload" src="https://example.com" onPageStatus={onPageStatus} />;
      }
      render(<Probe />);
      const guest = await screen.findByTestId("electron-browser-surface-webview");
      await waitFor(() => expect(observed.handle).not.toBeNull());
      Object.assign(guest, { canGoBack: () => false, canGoForward: () => false });
      return { handle: observed.handle!, guest, navigate };
    }

    it("retries the failed address, because the guest still holds the page the user clicked away from", async () => {
      const { handle, guest, navigate } = await mountWithBridge();
      guest.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://example.com/", isMainFrame: true }));
      guest.dispatchEvent(Object.assign(new Event("did-start-navigation"), { url: "https://self-signed.test/", isMainFrame: true, isInPlace: false }));
      guest.dispatchEvent(Object.assign(new Event("did-fail-load"), {
        validatedURL: "https://self-signed.test/",
        errorCode: -202,
        errorDescription: "ERR_CERT_AUTHORITY_INVALID",
        isMainFrame: true,
      }));
      const retry = vi.spyOn(browserSurfaceHost, "navigate");

      handle.reload();

      expect(retry).toHaveBeenCalledWith(IDENTITY, "https://self-signed.test/");
      expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ navigation: { kind: "reload" } }));
    });

    it("keeps reporting the retried address while it loads, so the tab address does not fall back to the stale page", async () => {
      const statuses: PreviewPageStatus[] = [];
      const { handle, guest } = await mountWithBridge((status) => statuses.push(status));
      guest.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://example.com/", isMainFrame: true }));
      guest.dispatchEvent(Object.assign(new Event("did-start-navigation"), { url: "https://self-signed.test/", isMainFrame: true, isInPlace: false }));
      guest.dispatchEvent(Object.assign(new Event("did-fail-load"), {
        validatedURL: "https://self-signed.test/",
        errorCode: -202,
        errorDescription: "ERR_CERT_AUTHORITY_INVALID",
        isMainFrame: true,
      }));
      statuses.length = 0;

      handle.reload();

      await waitFor(() => expect(statuses.some((status) => status.phase === "loading")).toBe(true));
      const loading = statuses.filter((status) => status.phase === "loading");
      expect(loading.map((status) => status.url)).toEqual(loading.map(() => "https://self-signed.test/"));
    });

    it("reloads the current page when the last load succeeded", async () => {
      const { handle, guest, navigate } = await mountWithBridge();
      guest.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://example.com/", isMainFrame: true }));
      guest.dispatchEvent(Object.assign(new Event("did-stop-loading"), { isMainFrame: true }));

      handle.reload();

      expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ navigation: { kind: "reload" } }));
    });
  });

  it("binds the viewport coordinator to the hosted target generation", async () => {
    window.desktopBridge = { preview: { surface: {
      prepare: vi.fn().mockResolvedValue({ ok: true }),
      adopt: vi.fn().mockResolvedValue({ ok: true }),
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      release: vi.fn().mockResolvedValue({ ok: true }),
      hidden: vi.fn().mockResolvedValue({ ok: true }),
    }, design: {} } } as unknown as NonNullable<typeof window.desktopBridge>;

    try {
      render(
        <PreviewWebview
          workspaceId="33333333-3333-4333-8333-333333333333"
          threadId="thread-generation"
          tabId="tab-generation"
          src="https://example.com"
        />,
      );
      const key = browserAutomationTargetKey("33333333-3333-4333-8333-333333333333", "thread-generation", "tab-generation");
      await waitFor(() => {
        expect(useBrowserAutomationStore.getState().viewportCoordinators.get(key)).toBeDefined();
      });

      await waitFor(() => {
        const store = useBrowserAutomationStore.getState();
        expect(store.viewportCoordinators.get(key)?.snapshot().targetGeneration).toBe(
          store.liveTargets.get(key)?.revision,
        );
        expect(store.liveTargets.get(key)?.revision).toBe(1);
      });
    } finally {
      releaseBrowserAutomationThreadScope("33333333-3333-4333-8333-333333333333", "thread-generation");
    }
  });

  it("preserves the Electron guest and generation when presentation remounts", async () => {
    const prepare = vi.fn().mockResolvedValue({ ok: true });
    const release = vi.fn().mockResolvedValue({ ok: true });
    window.desktopBridge = { preview: { surface: {
      prepare,
      adopt: vi.fn().mockResolvedValue({ ok: true }),
      navigate: vi.fn().mockResolvedValue({ ok: true }),
      release,
      hidden: vi.fn().mockResolvedValue({ ok: true }),
    } } } as unknown as NonNullable<typeof window.desktopBridge>;
    const props = {
      workspaceId: "44444444-4444-4444-8444-444444444444",
      threadId: "thread-remount",
      tabId: "tab-remount",
      src: "about:blank",
    };

    const first = render(<PreviewWebview {...props} />);
    const firstGeneration = prepare.mock.calls[0]?.[0].surface.generation as number;
    const firstGuest = await screen.findByTestId("electron-browser-surface-webview");
    const targetKey = browserAutomationTargetKey(props.workspaceId, props.threadId, props.tabId);
    const firstTargetGeneration = useBrowserAutomationStore.getState().liveTargets.get(targetKey)?.revision;
    first.unmount();
    expect(useBrowserAutomationStore.getState().liveTargets.get(targetKey)?.revision).toBe(
      firstTargetGeneration,
    );
    render(<PreviewWebview {...props} />);
    const snapshot = browserSurfaceHost.getSnapshot({
      workspaceId: props.workspaceId,
      scope: { kind: "thread", id: props.threadId },
      tabId: props.tabId,
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(screen.getByTestId("electron-browser-surface-webview")).toBe(firstGuest);
    expect(snapshot?.generation).toBe(firstGeneration);
    expect(useBrowserAutomationStore.getState().liveTargets.get(targetKey)?.revision).toBe(
      firstTargetGeneration,
    );
  });

  it("keeps native event subscriptions stable when parent callbacks change", async () => {
    window.desktopBridge = { preview: {} } as unknown as NonNullable<typeof window.desktopBridge>;
    const addEventListener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const firstStatus = vi.fn();
    const secondStatus = vi.fn();
    const { rerender } = render(
      <PreviewWebview
        threadId="thread-stable"
        tabId="tab-stable"
        src="https://example.com"
        onPageStatus={firstStatus}
      />,
    );
    const initialStopSubscriptions = addEventListener.mock.calls.filter(
      ([eventName]) => eventName === "did-stop-loading",
    ).length;

    rerender(
      <PreviewWebview
        threadId="thread-stable"
        tabId="tab-stable"
        src="https://example.com"
        onPageStatus={secondStatus}
      />,
    );
    firstStatus.mockClear();
    screen.getByTestId("web-runtime-preview-iframe").dispatchEvent(new Event("load"));

    expect(addEventListener.mock.calls.filter(
      ([eventName]) => eventName === "did-stop-loading",
    )).toHaveLength(initialStopSubscriptions);
    expect(firstStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(secondStatus).toHaveBeenCalled());
  });

  it("applies an exact renderer-owned design viewport to the visible webview", () => {
    render(
      <PreviewWebview
        threadId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        tabId="tab-1"
        src="https://example.com"
        viewport={{ width: 1024, height: 768 }}
      />,
    );
    expect(screen.getByTestId("preview-webview")).toHaveStyle({
      width: "1024px",
      height: "768px",
      pointerEvents: "none",
    });
  });

  it("keeps the transparent renderer anchor out of Browser hit testing", () => {
    render(
      <PreviewWebview
        threadId="thread-hit-test"
        tabId="tab-hit-test"
        src="https://example.com"
      />,
    );

    expect(screen.getByTestId("preview-webview")).toHaveStyle({ pointerEvents: "none" });
  });

  it("hides a warm inactive surface and presents it when selected", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    const { rerender } = render(
      <PreviewWebview
        active={false}
        threadId="thread-switch"
        tabId="tab-switch"
        src="https://example.com"
      />,
    );
    const surface = screen.getByTestId("web-runtime-preview-iframe");
    expect(surface).toHaveStyle({ visibility: "hidden", pointerEvents: "none" });

    rerender(
      <PreviewWebview
        active
        threadId="thread-switch"
        tabId="tab-switch"
        src="https://example.com"
      />,
    );

    expect(surface).toHaveStyle({
      left: "10px",
      top: "20px",
      width: "640px",
      height: "480px",
      visibility: "visible",
      pointerEvents: "auto",
    });
    rect.mockRestore();
  });

  it("re-measures a scaled responsive page when its layout key changes", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 768, 480),
    );
    const props = {
      threadId: "thread-layout-key",
      tabId: "tab-layout-key",
      src: "https://example.com",
      viewport: { width: 1280, height: 800 },
    };
    const { rerender } = render(<PreviewWebview {...props} layoutKey="0.6:832x664" />);
    const surface = screen.getByTestId("web-runtime-preview-iframe");
    expect(surface).toHaveStyle({ left: "10px", top: "20px" });

    rect.mockReturnValue(new DOMRect(32, 60, 784, 490));
    rerender(<PreviewWebview {...props} layoutKey="0.6:832x664" />);
    expect(surface).toHaveStyle({ left: "10px", top: "20px" });

    rerender(<PreviewWebview {...props} layoutKey="0.61:832x704" />);
    expect(surface).toHaveStyle({ left: "32px", top: "60px" });
    rect.mockRestore();
  });

  it("clips the covered edge without changing the Browser viewport geometry", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    const { rerender } = render(
      <PreviewWebview
        coveredRight={112}
        threadId="thread-covered"
        tabId="tab-covered"
        src="https://example.com"
      />,
    );
    const surface = screen.getByTestId("web-runtime-preview-iframe");

    expect(surface).toHaveStyle({
      left: "10px",
      width: "640px",
      clipPath: "inset(0px 112px 0px 0px round 0px 0px 0px 0px)",
    });

    rerender(
      <PreviewWebview
        coveredRight={0}
        threadId="thread-covered"
        tabId="tab-covered"
        src="https://example.com"
      />,
    );
    expect(surface.style.clipPath).toBe(
      "inset(0px 0px 0px 0px round 0px var(--radius-md) 0px 0px)",
    );
    rect.mockRestore();
  });

  it("presents an active automation surface inside its dedicated hidden host", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(-20_000, 0, 1280, 720),
    );
    const { rerender } = render(
      <div aria-hidden="true" inert>
        <PreviewWebview
          threadId="thread-background"
          tabId="tab-background"
          src="https://example.com"
        />
      </div>,
    );
    const surface = screen.getByTestId("web-runtime-preview-iframe");
    expect(surface).toHaveStyle({ visibility: "hidden", width: "1px", height: "1px" });

    rerender(
      <div aria-hidden="true" inert>
        <PreviewWebview
          allowHiddenPresentation
          threadId="thread-background"
          tabId="tab-background"
          src="https://example.com"
        />
      </div>,
    );

    expect(surface).toHaveStyle({
      left: "-20000px",
      width: "1280px",
      height: "720px",
      visibility: "visible",
    });
    rect.mockRestore();
  });

  it("hides and restores a warm normal presentation without replacing its generation", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    const props = {
      active: true,
      presentationActive: true,
      workspaceId: "55555555-5555-4555-8555-555555555555",
      threadId: "thread-warm",
      tabId: "tab-warm",
      src: "https://example.com",
      viewport: { width: 1280, height: 720 },
    } as const;
    const { rerender } = render(<PreviewWebview {...props} />);
    const surface = screen.getByTestId("web-runtime-preview-iframe");
    const identity = {
      workspaceId: props.workspaceId,
      scope: { kind: "thread" as const, id: props.threadId },
      tabId: props.tabId,
    };
    const generation = browserSurfaceHost.getSnapshot(identity)?.generation;
    expect(surface).toHaveStyle({ visibility: "visible", pointerEvents: "auto" });
    expect(surface).toHaveAttribute("aria-hidden", "false");

    rerender(
      <PreviewWebview
        {...props}
        presentationActive={false}
        viewport={{ width: 640, height: 360 }}
      />
    );
    expect(surface).toHaveStyle({ visibility: "hidden", pointerEvents: "none" });
    expect(surface).toHaveAttribute("aria-hidden", "true");
    expect(browserSurfaceHost.getSnapshot(identity)?.generation).toBe(generation);

    browserSurfaceHost.handleEvent({
      type: "title-updated",
      identity,
      generation: generation!,
      title: "Updated while hidden",
    });
    await waitFor(() => expect(surface).toHaveStyle({ visibility: "hidden" }));

    rerender(
      <PreviewWebview
        {...props}
        presentationActive
        viewport={{ width: 640, height: 360 }}
      />
    );
    expect(surface).toHaveStyle({
      visibility: "visible",
      pointerEvents: "auto",
      width: "640px",
      height: "360px",
    });
    expect(surface).toHaveAttribute("aria-hidden", "false");
    expect(browserSurfaceHost.getSnapshot(identity)?.generation).toBe(generation);

    browserSurfaceHost.handleEvent({
      type: "title-updated",
      identity,
      generation: generation!,
      title: "Updated after restore",
    });
    await waitFor(() => expect(surface).toHaveStyle({ width: "640px", height: "360px" }));
    rect.mockRestore();
  });

  it("hides a zero-layout active panel while retaining its warm generation", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 0, 0),
    );
    render(
      <PreviewWebview
        workspaceId="66666666-6666-4666-8666-666666666666"
        threadId="thread-zero"
        tabId="tab-zero"
        src="https://example.com"
      />,
    );
    const surface = screen.getByTestId("web-runtime-preview-iframe");
    const snapshot = browserSurfaceHost.getSnapshot({
      workspaceId: "66666666-6666-4666-8666-666666666666",
      scope: { kind: "thread", id: "thread-zero" },
      tabId: "tab-zero",
    });

    expect(snapshot?.generation).toBeDefined();
    expect(surface).toHaveStyle({ visibility: "hidden", pointerEvents: "none" });
    expect(surface).toHaveAttribute("aria-hidden", "true");
    rect.mockRestore();
  });

  it("uses the coordinator Activity Rail overlap when automation has no explicit override", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(10, 20, 640, 480),
    );
    window.desktopBridge = {
      preview: {
        surface: {
          prepare: vi.fn().mockResolvedValue({ ok: true }),
          adopt: vi.fn().mockResolvedValue({ ok: true }),
          navigate: vi.fn().mockResolvedValue({ ok: true }),
          release: vi.fn().mockResolvedValue({ ok: true }),
          hidden: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    } as unknown as NonNullable<typeof window.desktopBridge>;

    render(
      <PreviewWebview
        presentationSource="automation"
        workspaceId="77777777-7777-4777-8777-777777777777"
        threadId="thread-rail"
        tabId="tab-rail"
        src="https://example.com"
      />,
    );
    const anchor = screen.getByTestId("preview-webview");
    const releaseAnchor = browserSurfacePresentationCoordinator.registerAutomationAnchor(
      "77777777-7777-4777-8777-777777777777",
      "thread-rail",
      anchor,
    );
    browserSurfacePresentationCoordinator.setActivityRailOverlap(112);

    expect(await screen.findByTestId("electron-browser-surface-webview")).toHaveStyle({
      clipPath: "inset(0px 112px 0px 0px round 0px 0px 0px 0px)",
    });
    releaseAnchor();
    rect.mockRestore();
  });
});
