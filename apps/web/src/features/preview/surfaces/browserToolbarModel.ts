
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

/** A host the user chose to trust despite its certificate. Absent for every normally verified page. */
export interface BrowserTrustException {
  readonly host: string;
  readonly stopTrusting: () => void;
}

/** The address pill's inputs; editing works whether or not the last load succeeded. */
export interface BrowserAddress {
  readonly url: string;
  /** Set while this page loads only because the user trusted its certificate. */
  readonly trustException?: BrowserTrustException;
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

/**
 * Who holds the Browser, as the toolbar shows it. The provider is the thread's, so the pill names
 * the agent on the other side of the hold.
 */
export type BrowserControl =
  | { readonly kind: "none" }
  | { readonly kind: "agent-acting"; readonly provider: string; readonly takeControl: () => void }
  | { readonly kind: "user-holding"; readonly provider: string; readonly handBack: () => void };

/** The More menu's tools. Its command-backed actions are the ones the Browser keys run. */
export interface BrowserTools extends BrowserCommandActions {
  readonly zoom: BrowserZoom;
  readonly clearCookies: BrowserAction;
  readonly clearCache: BrowserAction;
}

/** A non-null reason disables the action. */
export function browserAction(reason: string | null, run: () => void): BrowserAction {
  return reason === null ? { kind: "enabled", run } : { kind: "disabled", reason };
}
