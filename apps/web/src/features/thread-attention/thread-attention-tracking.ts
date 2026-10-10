import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { threadAttentionStore } from "./thread-attention-store";

/** Observe loaded settled records only for the selected, focused conversation. */
export function startThreadAttentionTracking(): () => void {
  const refresh = (): void => {
    const threadId = useWorkspaceStore.getState().activeThreadId;
    const messages = threadId ? useThreadStore.getState().records.get(threadId)?.messages : undefined;
    const lastTurn = threadId ? threadAttentionStore.getState().byThreadId[threadId]?.lastTurn : null;
    const settled = messages?.flatMap((message) => message.serverSequence !== undefined
      && (message.outcome != null || message.serverSequence === lastTurn?.sequence)
      ? [message.serverSequence] : []) ?? [];
    threadAttentionStore.getState().refreshOnScreen(threadId, settled.length ? Math.max(...settled) : null);
  };
  const unsubscribeThread = useThreadStore.subscribe(refresh);
  const unsubscribeWorkspace = useWorkspaceStore.subscribe(refresh);
  const unsubscribeAttention = threadAttentionStore.subscribe((state, previous) => {
    if (state.byThreadId !== previous.byThreadId) refresh();
  });
  window.addEventListener("focus", refresh);
  window.addEventListener("blur", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();
  return () => {
    unsubscribeThread();
    unsubscribeWorkspace();
    unsubscribeAttention();
    window.removeEventListener("focus", refresh);
    window.removeEventListener("blur", refresh);
    document.removeEventListener("visibilitychange", refresh);
    threadAttentionStore.getState().refreshOnScreen(null, null);
  };
}
