import { afterEach, describe, expect, it } from "vitest";
import { installWindowChrome, trafficLightsReservePx, windowChromeKind } from "../window-chrome";

type DesktopWindowBridge = NonNullable<Window["desktopBridge"]>["window"];

function fakeDesktopWindow(platform: string) {
  const listeners = new Set<(fullScreen: boolean) => void>();
  const desktopWindow = {
    platform,
    onFullScreenChange: (callback: (fullScreen: boolean) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  } as Partial<DesktopWindowBridge>;
  return {
    desktopWindow: desktopWindow as DesktopWindowBridge,
    setFullScreen: (fullScreen: boolean) => listeners.forEach((listener) => listener(fullScreen)),
    listenerCount: () => listeners.size,
  };
}

describe("window chrome", () => {
  const root = document.documentElement;

  afterEach(() => {
    delete root.dataset.windowChrome;
    root.removeAttribute("data-full-screen");
    root.style.removeProperty("--traffic-lights-reserve");
  });

  it.each([
    [undefined, "web"],
    ["darwin", "traffic-lights"],
    ["win32", "caption-overlay"],
    ["linux", "caption-overlay"],
  ] as const)("maps platform %s to %s", (platform, kind) => {
    expect(windowChromeKind(platform)).toBe(kind);
  });

  it.each([
    ["traffic-lights", false, 68],
    ["traffic-lights", true, 0],
    ["caption-overlay", false, 0],
    ["web", false, 0],
  ] as const)("reserves %s px for %s (full screen %s)", (kind, fullScreen, px) => {
    expect(trafficLightsReservePx({ kind, fullScreen })).toBe(px);
  });

  it("drops the macOS lights slot in full screen and restores it on leave", () => {
    const { desktopWindow, setFullScreen } = fakeDesktopWindow("darwin");

    installWindowChrome(root, desktopWindow);
    expect(root.dataset.windowChrome).toBe("traffic-lights");
    expect(root.style.getPropertyValue("--traffic-lights-reserve")).toBe("68px");
    expect(root.hasAttribute("data-full-screen")).toBe(false);

    setFullScreen(true);
    expect(root.style.getPropertyValue("--traffic-lights-reserve")).toBe("0px");
    expect(root.hasAttribute("data-full-screen")).toBe(true);

    setFullScreen(false);
    expect(root.style.getPropertyValue("--traffic-lights-reserve")).toBe("68px");
    expect(root.hasAttribute("data-full-screen")).toBe(false);
  });

  it("stops following full screen after uninstall", () => {
    const { desktopWindow, listenerCount } = fakeDesktopWindow("win32");

    const uninstall = installWindowChrome(root, desktopWindow);
    expect(listenerCount()).toBe(1);
    uninstall();
    expect(listenerCount()).toBe(0);
  });

  it("marks the web build with no reserve", () => {
    installWindowChrome(root, undefined);

    expect(root.dataset.windowChrome).toBe("web");
    expect(root.style.getPropertyValue("--traffic-lights-reserve")).toBe("0px");
  });
});
