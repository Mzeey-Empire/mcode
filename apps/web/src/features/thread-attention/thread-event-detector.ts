import { hasUnseenRestartFailure, type ThreadAttention, type ThreadWaitingKind } from "@mcode/contracts/models/thread-attention";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { isWindowFocused } from "@/lib/window-focus";
import type { WorkspaceThread } from "@/lib/workspace-thread";
import { useSettingsStore } from "@/stores/settingsStore";
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
  /** Sequence of the newest planned-restart failure that left no failed turn. */
  restart: number | null;
}

/** A row state worth a toast, tied to the server fact that produced it. */
interface ThreadEvent {
  kind: "finished" | "failed" | "needs-you";
  label: string;
  source: "turn" | "waiting" | "restart";
  key: string;
  at: string;
  /** Files the turn changed; null when unknown or for a wait. */
  changedFileCount: number | null;
}

/** The OS notification payload the desktop bridge accepts for one thread. */
interface ThreadNotification {
  tag: string;
  title: string;
  body: string;
}

// The desktop main process rejects longer text, so a long thread title or branch is clipped here.
const NOTIFICATION_TITLE_MAX = 200;
const NOTIFICATION_BODY_MAX = 300;

const WAITING_LABEL: Record<ThreadWaitingKind, NeedsYouLabel> = {
  approval: "Approval required",
  questions: "Answers required",
  plan: "Plan ready",
};

function factsOf(attention: ThreadAttention | undefined): ThreadFacts {
  const waiting = attention?.waiting;
  return {
    turn: attention?.lastTurn?.sequence ?? null,
    waiting: waiting ? `${waiting.kind}@${waiting.since}` : null,
    restart: attention?.restartFailure?.sequence ?? null,
  };
}

/** A continuation that failed before it could start a turn alerts the same way a failed turn does. */
function restartFailureEvent(state: ThreadRowState, attention: ThreadAttention | undefined): ThreadEvent | null {
  const restart = attention?.restartFailure;
  if (state.kind !== "failed" || !restart || !hasUnseenRestartFailure(attention)) return null;
  return { kind: "failed", label: "Failed", source: "restart", key: `restart:${restart.sequence}`, at: restart.at, changedFileCount: null };
}

/** Finished, failed and live waits toast. An interrupted turn or a setup gate stays on its row only. */
function eventOf(state: ThreadRowState, attention: ThreadAttention | undefined): ThreadEvent | null {
  return restartFailureEvent(state, attention) ?? turnOrWaitingEvent(state, attention);
}

function turnOrWaitingEvent(state: ThreadRowState, attention: ThreadAttention | undefined): ThreadEvent | null {
  const turn = attention?.lastTurn;
  const waiting = attention?.waiting;
  if ((state.kind === "finished" || state.kind === "failed") && turn) {
    const label = state.kind === "finished" ? "Finished" : "Failed";
    return {
      kind: state.kind, label, source: "turn", key: `turn:${turn.sequence}`, at: turn.endedAt,
      changedFileCount: turn.changedFileCount,
    };
  }
  // A setup approval also reads "Approval required"; matching the waiting kind keeps it off.
  if (state.kind === "needs-you" && waiting && WAITING_LABEL[waiting.kind] === state.label) {
    const facts = factsOf(attention);
    return {
      kind: "needs-you", label: state.label, source: "waiting", key: `waiting:${facts.waiting}`, at: waiting.since,
      changedFileCount: null,
    };
  }
  return null;
}

function isTurnOrWaitingNews(event: ThreadEvent, facts: ThreadFacts, accounted: ThreadFacts | undefined): boolean {
  if (event.source === "turn") return (facts.turn ?? -1) > (accounted?.turn ?? -1);
  return facts.waiting !== accounted?.waiting;
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

function threadLocation(thread: WorkspaceThread | undefined): string {
  const worktreeName = thread?.worktree_path?.split(/[\\/]/).filter(Boolean).pop();
  return worktreeName || thread?.branch || "";
}

function notificationOf(threadId: string, thread: WorkspaceThread | undefined, event: ThreadEvent): ThreadNotification {
  const count = event.changedFileCount;
  const changed = count === null ? "" : `Changed ${count} ${count === 1 ? "file" : "files"}`;
  const body = [changed, threadLocation(thread)].filter(Boolean).join(" · ");
  return {
    tag: threadId,
    title: `${event.label}: ${thread?.title || "Untitled thread"}`.slice(0, NOTIFICATION_TITLE_MAX),
    body: body.slice(0, NOTIFICATION_BODY_MAX),
  };
}

/** Raise an OS notification too when the desktop app is in the background and notifications are on. */
function notifyDesktop(notification: ThreadNotification): void {
  const bridge = window.desktopBridge?.notifications;
  if (!bridge || isWindowFocused() || !useSettingsStore.getState().settings.notifications.enabled) return;
  bridge.show(notification).catch((error: unknown) => {
    console.error("[thread-event-detector] Failed to show the OS notification", error);
  });
}

/** What one thread shows right now, read from the same stores as its row. */
interface Sighting {
  thread: WorkspaceThread | undefined;
  state: ThreadRowState;
  event: ThreadEvent | null;
  facts: ThreadFacts;
  onScreen: boolean;
  unseenRestart: boolean;
}

function sight(threadId: string): Sighting {
  const { byThreadId, onScreenThreadId } = threadAttentionStore.getState();
  const attention = byThreadId[threadId];
  const thread = findThread(threadId);
  const state = readThreadRowState(threadId, thread?.clientPreparing === true, thread?.clientError != null);
  // A deleted thread keeps its attention facts but has nothing left to open.
  const event = thread ? eventOf(state, attention) : null;
  return {
    thread, state, event, facts: factsOf(attention), onScreen: onScreenThreadId === threadId,
    unseenRestart: hasUnseenRestartFailure(attention),
  };
}

function sameFacts(left: ThreadFacts | undefined, right: ThreadFacts): boolean {
  return left?.turn === right.turn && left.waiting === right.waiting && left.restart === right.restart;
}

/**
 * Toasts a thread's new outcome or wait while the user is elsewhere, and takes the
 * toast back once the row stops showing it. A fact counts as news only once: facts
 * from a snapshot hydration, or that arrive while the thread is on screen, are
 * accounted for without a toast, except an unseen restart failure, which toasts once. A running thread defers accounting, so a turn that
 * ends before the client sees its run stop still toasts when it does.
 */
export function startThreadEventDetector(): () => void {
  const accounted = new Map<string, ThreadFacts>();
  const shown = new Map<string, string>();
  // Restart failures toasted in this client session, by thread and failure sequence.
  const announcedRestarts = new Set<string>();
  // Threads a store change outside attention can still move: unaccounted facts or a live toast.
  const watched = new Set<string>();
  // A missing row means deleted only once it has loaded; before that its facts wait like a running turn.
  const loaded = new Set<string>();

  const withdraw = (threadId: string): void => {
    shown.delete(threadId);
    useToastStore.getState().dismissByKey(threadId);
  };

  const retractStale = (threadId: string, { event, onScreen }: Sighting): void => {
    if (shown.has(threadId) && (onScreen || shown.get(threadId) !== event?.key)) withdraw(threadId);
  };

  const announce = (threadId: string, thread: WorkspaceThread | undefined, event: ThreadEvent): void => {
    showToast(threadId, thread, event);
    notifyDesktop(notificationOf(threadId, thread, event));
    shown.set(threadId, event.key);
    if (event.source === "restart") announcedRestarts.add(`${threadId}:${event.key}`);
  };

  const isNews = (threadId: string, event: ThreadEvent, facts: ThreadFacts): boolean => {
    if (event.source === "restart") return !announcedRestarts.has(`${threadId}:${event.key}`);
    return isTurnOrWaitingNews(event, facts, accounted.get(threadId));
  };

  // Restart failures happen during startup, usually before this client hydrates, so a snapshot still announces
  // an unseen one once; turn and wait facts in a snapshot stay accounted for without a toast.
  const announceNews = (threadId: string, { thread, event, facts, onScreen }: Sighting, snapshot: boolean): void => {
    if (!event || onScreen || (snapshot && event.source !== "restart")) return;
    if (isNews(threadId, event, facts)) announce(threadId, thread, event);
  };

  // Any row state (unloaded, running, waiting) can hold back a restart failure's toast, so its accounting ignores
  // the row: it stays pending until it toasts, the user sees it, or its thread is deleted.
  const restartSettled = (threadId: string, { thread, facts, unseenRestart }: Sighting): boolean =>
    !unseenRestart || announcedRestarts.has(`${threadId}:restart:${facts.restart}`) || (loaded.has(threadId) && !thread);

  const turnSettled = (threadId: string, { state, onScreen }: Sighting, snapshot: boolean): boolean =>
    onScreen || snapshot || (loaded.has(threadId) && state.kind !== "running");

  const factsToAccount = (threadId: string, sighting: Sighting, snapshot: boolean): ThreadFacts => {
    const { facts } = sighting;
    const previous = accounted.get(threadId) ?? { turn: null, waiting: null, restart: null };
    const turnFacts = turnSettled(threadId, sighting, snapshot) ? facts : previous;
    const restart = restartSettled(threadId, sighting) ? facts.restart : previous.restart;
    return { turn: turnFacts.turn, waiting: turnFacts.waiting, restart };
  };

  const account = (threadId: string, sighting: Sighting, snapshot: boolean): void => {
    if (sighting.thread) loaded.add(threadId);
    accounted.set(threadId, factsToAccount(threadId, sighting, snapshot));
    if (shown.has(threadId) || !sameFacts(accounted.get(threadId), sighting.facts)) watched.add(threadId);
    else watched.delete(threadId);
  };

  const evaluate = (threadId: string, snapshot: boolean): void => {
    const sighting = sight(threadId);
    retractStale(threadId, sighting);
    announceNews(threadId, sighting, snapshot);
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
  const unsubscribeStartup = useThreadStartupStore.subscribe(evaluateWatched);
  const notifications = window.desktopBridge?.notifications;
  const notificationClick = notifications?.onClick(openThread);
  evaluateAll(true);

  return () => {
    unsubscribeAttention();
    unsubscribeThread();
    unsubscribeWorkspace();
    unsubscribeStartup();
    unsubscribeToasts();
    if (notificationClick) notifications?.offClick(notificationClick);
    for (const threadId of shown.keys()) withdraw(threadId);
  };
}
