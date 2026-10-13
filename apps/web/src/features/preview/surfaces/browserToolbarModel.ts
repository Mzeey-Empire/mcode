/**
 * The Browser toolbar's local UI model. Each runtime owner (desktop BrowserChrome,
 * WebRuntimePreview) translates its own capabilities into these shapes, so the
 * rendered controls never choose a target or carry a callable no-op.
 */

/** An action available here, or the reason it cannot run. */
export type BrowserAction =
  | { readonly kind: "enabled"; readonly run: () => void }
  | { readonly kind: "disabled"; readonly reason: string };

/** The three Browser actions that also have keyboard commands. */
export type BrowserCommandAction = "deviceToolbar" | "developerTools" | "forceReload";

/** The command-backed actions of one Browser owner, keyed by {@link BrowserCommandAction}. */
export type BrowserCommandActions = { readonly [action in BrowserCommandAction]: BrowserAction };
