/** Actor holding the thread's Browser control. */
export type BrowserHolder = "none" | "agent" | "user";

/** Thread-wide control hold with independent observation epochs for each tab. */
export interface BrowserThreadControl {
  readonly holder: BrowserHolder;
  readonly heldTabId: string | null;
  readonly epochByTab: ReadonlyMap<string, number>;
}

/** Events that can change Browser control. Sending a message is not a control event. */
export type BrowserControlEvent =
  | { type: "agent-effect"; tabId: string; expectedEpoch: number }
  | { type: "user-input"; tabId: string }
  | { type: "take-control"; tabId: string }
  | { type: "hand-back" }
  | { type: "agent-turn-ended" }
  | { type: "tab-closed"; tabId: string };

/** Admission result and immutable next control state. */
export type BrowserControlDecision =
  | { admitted: true; next: BrowserThreadControl }
  | { admitted: false; code: "HUMAN_INTERRUPTED" | "STALE_CONTROL_EPOCH"; next: BrowserThreadControl };

/** Creates an unclaimed Browser with no observed tabs. */
export function createBrowserThreadControl(): BrowserThreadControl {
  return { holder: "none", heldTabId: null, epochByTab: new Map() };
}

function takeControl(
  state: BrowserThreadControl,
  event: Extract<BrowserControlEvent, { type: "user-input" | "take-control" }>,
): BrowserThreadControl {
  if (state.holder === "user") return state;
  const epochByTab = new Map(state.epochByTab);
  epochByTab.set(event.tabId, (epochByTab.get(event.tabId) ?? 0) + 1);
  const holdsControl = state.holder === "agent" || event.type === "take-control";
  return {
    holder: holdsControl ? "user" : "none",
    heldTabId: holdsControl ? event.tabId : null,
    epochByTab,
  };
}

function admitEffect(
  state: BrowserThreadControl,
  event: Extract<BrowserControlEvent, { type: "agent-effect" }>,
): BrowserControlDecision {
  if (state.holder === "user") return { admitted: false, code: "HUMAN_INTERRUPTED", next: state };
  const epoch = state.epochByTab.get(event.tabId) ?? 0;
  if (event.expectedEpoch !== epoch) return { admitted: false, code: "STALE_CONTROL_EPOCH", next: state };
  const epochByTab = new Map(state.epochByTab);
  epochByTab.set(event.tabId, epoch);
  return { admitted: true, next: { holder: "agent", heldTabId: null, epochByTab } };
}

function handBack(state: BrowserThreadControl): BrowserThreadControl {
  if (state.holder !== "user" || state.heldTabId === null) return state;
  const epochByTab = new Map(state.epochByTab);
  epochByTab.set(state.heldTabId, (epochByTab.get(state.heldTabId) ?? 0) + 1);
  return { holder: "none", heldTabId: null, epochByTab };
}

function endAgentTurn(state: BrowserThreadControl): BrowserThreadControl {
  if (state.holder !== "agent") return state;
  const epochByTab = new Map(state.epochByTab);
  for (const [tabId, epoch] of epochByTab) epochByTab.set(tabId, epoch + 1);
  return { holder: "none", heldTabId: null, epochByTab };
}

/** Applies Browser admission and hold rules without mutating the previous state. */
export function reduceBrowserControl(state: BrowserThreadControl, event: BrowserControlEvent): BrowserControlDecision {
  switch (event.type) {
    case "agent-effect":
      return admitEffect(state, event);
    case "user-input":
    case "take-control":
      return { admitted: true, next: takeControl(state, event) };
    case "hand-back":
      return { admitted: true, next: handBack(state) };
    case "agent-turn-ended":
      return { admitted: true, next: endAgentTurn(state) };
    case "tab-closed": {
      const epochByTab = new Map(state.epochByTab);
      epochByTab.delete(event.tabId);
      const holder = state.heldTabId === event.tabId ? "none" : state.holder;
      const heldTabId = state.heldTabId === event.tabId ? null : state.heldTabId;
      return { admitted: true, next: { holder, heldTabId, epochByTab } };
    }
  }
}
