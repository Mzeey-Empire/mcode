import { browserAutomationTargetKey, useBrowserAutomationStore } from "../automation/browserAutomationStore";

/**
 * Whether the agent is visibly acting on one Browser tab: it holds the tab and either has an
 * effect running or finished one within the last few seconds. One selector feeds the control
 * pill, page glow, tab pointer and every other agent-activity cue, so they never disagree.
 */
export function useBrowserActing(workspaceId: string, threadId: string, tabId: string): boolean {
  return useBrowserAutomationStore((state) => {
    const key = browserAutomationTargetKey(workspaceId, threadId, tabId);
    return state.actingTargets.has(key) && state.controllers.get(key)?.controller === "agent";
  });
}

/**
 * Whether the user holds the thread's Browser until they hand it back. The hold is per thread, so
 * any tab held by the user counts.
 */
export function useBrowserUserHolding(workspaceId: string, threadId: string): boolean {
  return useBrowserAutomationStore((state) => {
    for (const target of state.liveTargets.values()) {
      if (target.workspaceId !== workspaceId || target.threadId !== threadId) continue;
      if (state.controllers.get(browserAutomationTargetKey(workspaceId, threadId, target.tabId))?.controller === "human") {
        return true;
      }
    }
    return false;
  });
}
