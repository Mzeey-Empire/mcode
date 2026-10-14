
/** An action available here, or the reason it cannot run. */
export type BrowserAction =
  | { readonly kind: "enabled"; readonly run: () => void }
  | { readonly kind: "disabled"; readonly reason: string };

/** The three Browser actions that also have keyboard commands. */
export type BrowserCommandAction = "deviceToolbar" | "developerTools" | "forceReload";

/** Command-backed actions for one Browser owner. */
export type BrowserCommandActions = { readonly [action in BrowserCommandAction]: BrowserAction };

/** Page tools requiring a desktop guest. */
export type BrowserPageActions =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "desktop";
      readonly designActive: boolean;
      readonly design: BrowserAction;
      readonly screenshotArmed: boolean;
      readonly screenshot: BrowserAction;
    };

/** History and reload controls for a page that has an address. */
export interface BrowserNavigation {
  readonly back: BrowserAction;
  readonly forward: BrowserAction;
  readonly reload: BrowserAction;
}

/** Toolbar state. Errors take precedence; "loaded" includes pages still loading. */
export type BrowserToolbarPage =
  | { readonly kind: "new" }
  | { readonly kind: "error"; readonly navigation: BrowserNavigation }
  | {
      readonly kind: "loaded";
      readonly navigation: BrowserNavigation;
      readonly pageActions: BrowserPageActions;
    };

/** The address pill's inputs; editing works whether or not the last load succeeded. */
export interface BrowserAddress {
  readonly url: string;
  readonly onNavigate: (input: string) => void;
  readonly openExternal: BrowserAction;
  /** Called when a human focuses the address, so automation observation can be invalidated. */
  readonly onHumanFocus: () => void;
}

/** Guest zoom: `read` and `set` resolve to the factor the surface actually applied. */
export type BrowserZoom =
  | { readonly kind: "disabled"; readonly reason: string }
  | {
      readonly kind: "enabled";
      readonly read: () => Promise<number>;
      readonly set: (factor: number) => Promise<number>;
    };

/** Whether the human can take the active page back from the agent. */
export type BrowserTakeover =
  | { readonly kind: "none" }
  | { readonly kind: "agent"; readonly busy: boolean; readonly takeControl: () => void };

/** The More menu's tools. Its command-backed actions are the ones the Browser keys run. */
export interface BrowserTools extends BrowserCommandActions {
  readonly zoom: BrowserZoom;
  readonly clearCookies: BrowserAction;
  readonly clearCache: BrowserAction;
  readonly takeover: BrowserTakeover;
}

/** A non-null reason disables the action. */
export function browserAction(reason: string | null, run: () => void): BrowserAction {
  return reason === null ? { kind: "enabled", run } : { kind: "disabled", reason };
}
