/** True while the window is visible and has focus, so the user can see what it shows. */
export function isWindowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function syncMotion(): void {
  document.documentElement.dataset.motion = isWindowFocused() ? "live" : "paused";
}

/**
 * Keeps `data-motion` on the root element at `"live"` or `"paused"`, so looping
 * animations stop painting while nobody can see the window.
 */
export function startMotionGate(): void {
  syncMotion();
  window.addEventListener("focus", syncMotion);
  window.addEventListener("blur", syncMotion);
  document.addEventListener("visibilitychange", syncMotion);
}
