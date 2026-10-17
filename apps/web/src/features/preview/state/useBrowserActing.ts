import {
  browserAutomationTargetKey,
  isBrowserAutomationAgentControlled,
  parseBrowserAutomationTargetKey,
  useBrowserAutomationStore,
} from "../automation/browserAutomationStore";

type ActingState = ReturnType<typeof useBrowserAutomationStore.getState>;

function isTabActing(state: ActingState, workspaceId: string, threadId: string, tabId: string): boolean {
  const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
  return isBrowserAutomationAgentControlled(state, workspaceId, threadId, tabId) && state.controllers.get(key)?.controller !== "human";
}

function actingTabId(state: ActingState, workspaceId: string, threadId: string): string | null {
  const tabIds = new Set<string>();
  for (const pending of state.pendingAgentOpens.values()) {
    if (pending.workspaceId === workspaceId && pending.threadId === threadId) tabIds.add(pending.tabId);
  }
  for (const key of state.actingTargets) {
    const target = parseBrowserAutomationTargetKey(key);
    if (target?.workspaceId === workspaceId && target.threadId === threadId) tabIds.add(target.tabId);
  }
  return [...tabIds].find((tabId) => isTabActing(state, workspaceId, threadId, tabId)) ?? null;
}

function userHeldTabId(state: ActingState, workspaceId: string, threadId: string): string | null {
  for (const target of state.liveTargets.values()) {
    if (target.workspaceId !== workspaceId || target.threadId !== threadId) continue;
    if (state.controllers.get(browserAutomationTargetKey(workspaceId, threadId, target.tabId))?.controller === "human") {
      return target.tabId;
    }
  }
  return null;
}

/**
 * Whether the agent is visibly acting on one Browser tab: it holds the tab and either has an
 * effect running or finished one within the last few seconds. One selector feeds the control
 * pill, page glow, tab pointer and every other agent-activity cue, so they never disagree.
 */
export function useBrowserActing(workspaceId: string, threadId: string, tabId: string): boolean {
  return useBrowserAutomationStore((state) => isTabActing(state, workspaceId, threadId, tabId));
}

/** Whether the agent is visibly acting on any Browser tab of the thread, for the tool's rail entry. */
export function useBrowserThreadActing(workspaceId: string, threadId: string): boolean {
  return useBrowserAutomationStore((state) => actingTabId(state, workspaceId, threadId) !== null);
}

/** The Browser tab the agent is visibly acting on in the thread, or null when it is idle. */
export function useBrowserActingTabId(workspaceId: string, threadId: string): string | null {
  return useBrowserAutomationStore((state) => actingTabId(state, workspaceId, threadId));
}

/**
 * Whether the user holds the thread's Browser until they hand it back. The hold is per thread, so
 * any tab held by the user counts.
 */
export function useBrowserUserHolding(workspaceId: string, threadId: string): boolean {
  return useBrowserAutomationStore((state) => userHeldTabId(state, workspaceId, threadId) !== null);
}

/** The Browser tab the user took control of, or null when the thread's Browser is not held. */
export function useBrowserUserHeldTabId(workspaceId: string, threadId: string): string | null {
  return useBrowserAutomationStore((state) => userHeldTabId(state, workspaceId, threadId));
}
