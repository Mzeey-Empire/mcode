/** How the native window frame overlaps the renderer's top edge. */
export type WindowChromeKind = "web" | "caption-overlay" | "traffic-lights";

/** Native frame facts the header layout depends on. */
export interface WindowChrome {
  readonly kind: WindowChromeKind;
  readonly fullScreen: boolean;
}

type DesktopWindowBridge = NonNullable<Window["desktopBridge"]>["window"];

/** Width of the macOS traffic-light slot: x=14 plus three 12px lights and gaps. */
export const TRAFFIC_LIGHTS_RESERVE_PX = 68;

/** Map the Electron host platform to its frame kind. No platform means the web build. */
export function windowChromeKind(platform: string | undefined): WindowChromeKind {
  if (platform === undefined) return "web";
  return platform === "darwin" ? "traffic-lights" : "caption-overlay";
}

/** Horizontal space the macOS lights take from the left of the top row. */
export function trafficLightsReservePx(chrome: WindowChrome): number {
  // macOS hides the lights in full screen, so their slot would be dead space.
  return chrome.kind === "traffic-lights" && !chrome.fullScreen ? TRAFFIC_LIGHTS_RESERVE_PX : 0;
}

/** Publish the chrome on the root element for CSS and layout code. */
export function applyWindowChrome(root: HTMLElement, chrome: WindowChrome): void {
  root.dataset.windowChrome = chrome.kind;
  root.toggleAttribute("data-full-screen", chrome.fullScreen);
  root.style.setProperty("--traffic-lights-reserve", `${trafficLightsReservePx(chrome)}px`);
}

/** Apply the initial chrome and follow full-screen changes. Returns an unsubscribe. */
export function installWindowChrome(
  root: HTMLElement,
  desktopWindow: DesktopWindowBridge | undefined,
): () => void {
  const kind = windowChromeKind(desktopWindow?.platform);
  applyWindowChrome(root, { kind, fullScreen: false });
  if (!desktopWindow) return () => {};
  return desktopWindow.onFullScreenChange((fullScreen) => applyWindowChrome(root, { kind, fullScreen }));
}
