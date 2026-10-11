import { HOME_TERMINAL_SCOPE_ID } from "@mcode/contracts";
import type { TerminalPoolSurface } from "./TerminalPoolSlotContext";

/** Inputs that decide which scope the single pooled terminal view presents. */
export interface TerminalPoolPresentationInput {
  readonly homePresented: boolean;
  readonly activeThreadId: string | null;
  readonly activeWorkspaceId: string | null;
  readonly panelTerminalTabVisible: boolean;
}

/** The scope the pooled view presents, the surface it displays in, and whether that surface is showing. */
export interface TerminalPoolPresentation {
  readonly scopeId: string | null;
  readonly surface: TerminalPoolSurface;
  readonly visible: boolean;
}

/**
 * Picks what the single pooled terminal view presents (ADR-0010). The sign-in
 * dialog is modal, so while the home scope holds a terminal it takes the view
 * from the right panel. Otherwise the view follows the active thread, or the
 * workspace itself in the threadless new-thread view.
 */
export function resolvePoolPresentation(input: TerminalPoolPresentationInput): TerminalPoolPresentation {
  if (input.homePresented) {
    return { scopeId: HOME_TERMINAL_SCOPE_ID, surface: "dialog", visible: true };
  }
  return {
    scopeId: input.activeThreadId ?? input.activeWorkspaceId,
    surface: "panel",
    visible: input.panelTerminalTabVisible,
  };
}
