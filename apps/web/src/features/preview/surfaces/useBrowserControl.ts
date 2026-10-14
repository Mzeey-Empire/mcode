import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { handBackBrowserControl, interruptBrowserAutomationTarget } from "../automation/browserAutomationStore";
import { useBrowserActing, useBrowserUserHolding } from "../state/useBrowserActing";
import type { BrowserControl } from "./browserToolbarModel";

/** Who holds one Browser tab for the toolbar: the acting agent, the user until Hand back, or no one. */
export function useBrowserControl(workspaceId: string, threadId: string, tabId: string): BrowserControl {
  const acting = useBrowserActing(workspaceId, threadId, tabId);
  const holding = useBrowserUserHolding(workspaceId, threadId);
  const provider = useWorkspaceStore((state) => state.threads.find((thread) => thread.id === threadId)?.provider ?? "");
  if (holding) {
    return { kind: "user-holding", provider, handBack: () => void handBackBrowserControl(workspaceId, threadId) };
  }
  if (!acting) return { kind: "none" };
  return {
    kind: "agent-acting",
    provider,
    takeControl: () => interruptBrowserAutomationTarget(workspaceId, threadId, tabId, "user-stopped"),
  };
}
