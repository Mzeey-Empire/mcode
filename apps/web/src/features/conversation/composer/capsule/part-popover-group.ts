/** The three parts of the split capsule, left to right. */
export const CAPSULE_PARTS = ["model", "reasoning", "access"] as const;

/** One part of the split capsule; each opens its own popover body in the shared spot. */
export type CapsulePart = (typeof CAPSULE_PARTS)[number];

/**
 * Resting this long on another part while a popover is open switches to its popover, as a menu bar does. A pointer
 * crossing a part on its way up to the popover must not switch it.
 */
export const SWITCH_DWELL_MS = 100;

/**
 * Which part's popover is open. Closed carries no query or tab, so the model search and provider tab survive switches
 * and start over only after closing. A `null` tab means the picker's default.
 */
export type PartPopoverState =
  | { readonly status: "closed" }
  | { readonly status: "open"; readonly part: CapsulePart; readonly modelQuery: string; readonly modelTab: string | null };

/** What can happen to the capsule's popovers. */
export type PartPopoverEvent =
  /** Base UI requested open on this part's trigger. */
  | { readonly type: "open"; readonly part: CapsulePart }
  /** The pointer rested {@link SWITCH_DWELL_MS} on this part; hover never opens from nothing. */
  | { readonly type: "dwell"; readonly part: CapsulePart }
  | { readonly type: "modelPicked"; readonly reasoningAvailable: boolean }
  | { readonly type: "query"; readonly text: string }
  | { readonly type: "tab"; readonly tab: string }
  /** Base UI requested close. */
  | { readonly type: "dismiss" };

const CLOSED: PartPopoverState = { status: "closed" };

function switchTo(state: PartPopoverState, part: CapsulePart): PartPopoverState {
  if (state.status === "closed") return { status: "open", part, modelQuery: "", modelTab: null };
  if (state.part === part) return state;
  return { ...state, part };
}

function whileOpen(
  state: PartPopoverState,
  next: (open: Extract<PartPopoverState, { status: "open" }>) => PartPopoverState,
): PartPopoverState {
  return state.status === "open" ? next(state) : state;
}

function chainToReasoning(state: PartPopoverState, reasoningAvailable: boolean): PartPopoverState {
  return whileOpen(state, (open) => (open.part === "model" && reasoningAvailable ? switchTo(open, "reasoning") : open));
}

/**
 * Pure transitions. A no-op returns the same state object so React bails out. A model pick without reasoning keeps
 * the state: the host closes through the popover root so the popup pours back, which then dispatches `dismiss`.
 */
export function partPopoverReducer(state: PartPopoverState, event: PartPopoverEvent): PartPopoverState {
  switch (event.type) {
    case "open":
      return switchTo(state, event.part);
    case "dwell":
      return whileOpen(state, (open) => switchTo(open, event.part));
    case "modelPicked":
      return chainToReasoning(state, event.reasoningAvailable);
    case "query":
      return whileOpen(state, (open) => ({ ...open, modelQuery: event.text }));
    case "tab":
      return whileOpen(state, (open) => ({ ...open, modelTab: event.tab }));
    case "dismiss":
      return whileOpen(state, () => CLOSED);
  }
}
