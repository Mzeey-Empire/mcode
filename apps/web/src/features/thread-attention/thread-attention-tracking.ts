import { MessageSchema } from "@mcode/contracts/models/message";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import type { ThreadRecord } from "@/stores/thread-record";
import { threadAttentionStore } from "./thread-attention-store";

/**
 * Accepted executions settle through saved canonical batches without a `turn.persisted`
 * patch, so their committed messages carry the server sequence directly.
 */
function serverSequencedMessages(record: ThreadRecord | undefined): { sequence: number; outcome?: string | null }[] {
  if (!record) return [];
  const durable = Object.values(record.canonicalAgent.durableState.items).flatMap((item) => {
    if (item.payload.projection !== "message") return [];
    const parsed = MessageSchema().safeParse(item.payload.message);
    return parsed.success ? [parsed.data] : [];
  });
  const patched = record.messages.flatMap((message) => message.serverSequence === undefined ? []
    : [{ sequence: message.serverSequence, outcome: message.outcome }]);
  return [...patched, ...durable];
}

/** Observe loaded settled records only for the selected, focused conversation. */
export function startThreadAttentionTracking(): () => void {
  const refresh = (): void => {
    const threadId = useWorkspaceStore.getState().activeThreadId;
    const record = threadId ? useThreadStore.getState().records.get(threadId) : undefined;
    const lastTurn = threadId ? threadAttentionStore.getState().byThreadId[threadId]?.lastTurn : null;
    const settled = serverSequencedMessages(record).flatMap((message) =>
      message.outcome != null || message.sequence === lastTurn?.sequence ? [message.sequence] : []);
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
