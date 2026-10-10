import { useEffect, type RefObject } from "react";

/** Open popovers, menus, pickers and dialogs own Esc, so a startup cancel must wait until none is mounted. */
const OPEN_OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** A thread whose startup has not ended. `onCancel` is absent once cancellation is requested. */
export interface ComposerStartingThread {
  readonly onCancel: (() => void) | undefined;
}

/**
 * Resolves the composer's starting state and wires Esc to cancel the startup.
 *
 * A client-side scaffold (a thread still being created) also counts as starting, but has no startup to cancel.
 * Branch mode owns Esc to exit itself, so it never cancels a startup.
 */
export function useComposerStartup(
  scaffolding: boolean,
  startup: ComposerStartingThread | undefined,
  branchMode: boolean,
  composerRef: RefObject<HTMLElement | null>,
): { readonly startingThread: boolean; readonly cancelStartup: (() => void) | undefined } {
  const cancelStartup = startup?.onCancel;
  useStartupEscapeCancel(branchMode ? undefined : cancelStartup, composerRef);
  return { startingThread: scaffolding || startup !== undefined, cancelStartup };
}

/**
 * Cancels a starting thread on Esc while focus sits in its thread view and no overlay is open.
 *
 * Listens in the capture phase so an overlay that closes itself on this same Esc is still mounted,
 * and that Esc closes only the overlay.
 */
function useStartupEscapeCancel(onCancel: (() => void) | undefined, composerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!onCancel) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) return;
      if (!focusIsInThreadView(composerRef.current)) return;
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel, composerRef]);
}

function focusIsInThreadView(composer: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  const threadView = composer?.closest("[data-thread-view]") ?? composer;
  return threadView?.contains(active) ?? false;
}
