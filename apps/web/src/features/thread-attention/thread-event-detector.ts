import type { ThreadAttention, ThreadWaitingKind } from "@mcode/contracts";
import { useProjectAutomaticSetupStore } from "@/features/projects/environment";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { useUiStore } from "@/stores/uiStore";
import { threadAttentionStore } from "./thread-attention-store";
import { readThreadRowState } from "./thread-row-presentation";
import type { NeedsYouLabel, ThreadRowState } from "./thread-row-state";

/** The newest server facts about a thread: its last settled turn and its live wait. */
interface ThreadFacts {
  turn: number | null;
  waiting: string | null;
}

/** A row state worth a toast, tied to the server fact that produced it. */
interface ThreadEvent {
  kind: "finished" | "failed" | "needs-you";
  label: string;
  source: "turn" | "waiting";
  key: string;
  at: string;
}

const WAITING_LABEL: Record<ThreadWaitingKind, NeedsYouLabel> = {
  approval: "Approval required",
  questions: "Answers required",
  plan: "Plan ready",
};

function factsOf(attention: ThreadAttention | undefined): ThreadFacts {
  const waiting = attention?.waiting;
  return { turn: attention?.lastTurn?.sequence ?? null, waiting: waiting ? `${waiting.kind}@${waiting.since}` : null };
}

/** Finished, failed and live waits toast. An interrupted turn or a setup gate stays on its row only. */
function eventOf(state: ThreadRowState, attention: ThreadAttention | undefined): ThreadEvent | null {
  const turn = attention?.lastTurn;
  const waiting = attention?.waiting;
  if ((state.kind === "finished" || state.kind === "failed") && turn) {
    const label = state.kind === "finished" ? "Finished" : "Failed";
    return { kind: state.kind, label, source: "turn", key: `turn:${turn.sequence}`, at: turn.endedAt };
  }
  // A setup approval also reads "Approval required"; matching the waiting kind keeps it off.
  if (state.kind === "needs-you" && waiting && WAITING_LABEL[waiting.kind] === state.label) {
    const facts = factsOf(attention);
    return { kind: "needs-you", label: state.label, source: "waiting", key: `waiting:${facts.waiting}`, at: waiting.since };
  }
  return null;
}

function isNews(event: ThreadEvent, facts: ThreadFacts, accounted: ThreadFacts | undefined): boolean {
  return event.source === "turn"
    ? (facts.turn ?? -1) > (accounted?.turn ?? -1)
    : facts.waiting !== accounted?.waiting;
}

function clockTime(iso: string): string {
  const parsed = new Date(iso);
  const time = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

function findThread(threadId: string): WorkspaceThread | undefined {
  return useWorkspaceStore.getState().threads.find((thread) => thread.id === threadId);
}

function openThread(threadId: string): void {
  const workspaceId = findThread(threadId)?.workspace_id;
  if (workspaceId) useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
  useUiStore.getState().setPrimarySurface("chat");
  useWorkspaceStore.getState().setActiveThread(threadId);
}

function showToast(threadId: string, thread: WorkspaceThread | undefined, event: ThreadEvent): void {
  useToastStore.getState().show({
    kind: event.kind,
    title: thread?.title || "Untitled thread",
    meta: `${event.label} · ${clockTime(event.at)}`,
    dedupeKey: threadId,
    onOpen: () => openThread(threadId),
  });
}

/** What one thread shows right now, read from the same stores as its row. */
interface Sighting {
  thread: WorkspaceThread | undefined;
  state: ThreadRowState;
  event: ThreadEvent | null;
  facts: ThreadFacts;
  onScreen: boolean;
}

function sight(threadId: string): Sighting {
  const { byThreadId, onScreenThreadId } = threadAttentionStore.getState();
  const attention = byThreadId[threadId];
  const thread = findThread(threadId);
  const state = readThreadRowState(threadId, thread?.clientPreparing === true);
  // A deleted thread keeps its attention facts but has nothing left to open.
  const event = thread ? eventOf(state, attention) : null;
  return { thread, state, event, facts: factsOf(attention), onScreen: onScreenThreadId === threadId };
}

function sameFacts(left: ThreadFacts | undefined, right: ThreadFacts): boolean {
  return left?.turn === right.turn && left.waiting === right.waiting;
}

/**
 * Toasts a thread's new outcome or wait while the user is elsewhere, and takes the
 * toast back once the row stops showing it. A fact counts as news only once: facts
 * from a snapshot hydration, or that arrive while the thread is on screen, are
 * accounted for without a toast. A running thread defers accounting, so a turn that
 * ends before the client sees its run stop still toasts when it does.
 */
export function startThreadEventDetector(): () => void {
  const accounted = new Map<string, ThreadFacts>();
  const shown = new Map<string, string>();
  // Threads a store change outside attention can still move: unaccounted facts or a live toast.
  const watched = new Set<string>();

  const withdraw = (threadId: string): void => {
    shown.delete(threadId);
    useToastStore.getState().dismissByKey(threadId);
  };

  const retractStale = (threadId: string, { event, onScreen }: Sighting): void => {
    if (shown.has(threadId) && (onScreen || shown.get(threadId) !== event?.key)) withdraw(threadId);
  };

  const announceNews = (threadId: string, { thread, event, facts, onScreen }: Sighting): void => {
    if (!event || onScreen || !isNews(event, facts, accounted.get(threadId))) return;
    showToast(threadId, thread, event);
    shown.set(threadId, event.key);
  };

  const account = (threadId: string, { state, facts, onScreen }: Sighting, snapshot: boolean): void => {
    if (onScreen || snapshot || state.kind !== "running") accounted.set(threadId, facts);
    if (shown.has(threadId) || !sameFacts(accounted.get(threadId), facts)) watched.add(threadId);
    else watched.delete(threadId);
  };

  const evaluate = (threadId: string, snapshot: boolean): void => {
    const sighting = sight(threadId);
    retractStale(threadId, sighting);
    if (!snapshot) announceNews(threadId, sighting);
    account(threadId, sighting, snapshot);
  };

  const evaluateAll = (snapshot: boolean): void => {
    for (const threadId of Object.keys(threadAttentionStore.getState().byThreadId)) evaluate(threadId, snapshot);
  };
  const evaluateWatched = (): void => {
    for (const threadId of watched) evaluate(threadId, false);
  };

  const unsubscribeAttention = threadAttentionStore.subscribe((state, previous) => {
    const hydrated = state.hydrations !== previous.hydrations;
    // A hydration keeps a newer live fact in place, and that fact is still news.
    for (const threadId of Object.keys(state.byThreadId)) {
      evaluate(threadId, hydrated && state.byThreadId[threadId] !== previous.byThreadId[threadId]);
    }
  });
  // A toast that expired, was closed, or was pushed out of the lane stops holding its thread.
  const unsubscribeToasts = useToastStore.subscribe(({ toasts }) => {
    const live = new Set(toasts.map((toast) => toast.dedupeKey));
    for (const threadId of shown.keys()) {
      if (live.has(threadId)) continue;
      shown.delete(threadId);
      evaluate(threadId, false);
    }
  });
  const unsubscribeThread = useThreadStore.subscribe(evaluateWatched);
  const unsubscribeWorkspace = useWorkspaceStore.subscribe(evaluateWatched);
  const unsubscribeSetup = useProjectAutomaticSetupStore.subscribe(evaluateWatched);
  evaluateAll(true);

  return () => {
    unsubscribeAttention();
    unsubscribeThread();
    unsubscribeWorkspace();
    unsubscribeSetup();
    unsubscribeToasts();
    for (const threadId of shown.keys()) withdraw(threadId);
  };
}
