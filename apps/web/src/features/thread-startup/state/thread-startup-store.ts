import { useEffect, useState } from "react";
import { create } from "zustand";
import type { ThreadStartup } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadStore } from "@/stores/threadStore";
import { patchThreadRecord } from "@/stores/thread-record";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { createDefaultComposerAgentSelection } from "@/features/conversation/composer/draft/composer-selection-state";

interface ThreadStartupState {
  readonly recordsByStartupId: Readonly<Record<string, ThreadStartup>>;
  readonly startupIdByThreadId: Readonly<Record<string, string>>;
  /** Cancelled startups the user dismissed; the preparing shell stops pinning them. */
  readonly dismissedStartupIds: ReadonlySet<string>;
  apply: (startup: ThreadStartup) => void;
  dismissStartup: (startupId: string) => void;
  recover: (input: { readonly startupId?: string; readonly workspaceId?: string }) => Promise<void>;
}

function startupForThread(
  recordsByStartupId: Readonly<Record<string, ThreadStartup>>,
  startupIdByThreadId: Readonly<Record<string, string>>,
  startupId: string | undefined,
  threadId: string | undefined,
): ThreadStartup | undefined {
  if (startupId) return recordsByStartupId[startupId];
  return threadId ? recordsByStartupId[startupIdByThreadId[threadId] ?? ""] : undefined;
}

/** Keep the unsent first message available when startup stops before agent admission. */
function restoreUnsentDraft(startup: ThreadStartup, pendingKey: string): void {
  const draftStore = useComposerDraftStore.getState();
  const parked = draftStore.getDraft(pendingKey);
  const target = startup.threadId ?? pendingKey;
  if (parked && target !== pendingKey) draftStore.saveDraft(target, parked);
  else if (!parked) {
    const queued = useWorkspaceStore.getState().pendingStartupByThreadId[pendingKey]?.queuedMessage;
    if (queued) {
      const selection = createDefaultComposerAgentSelection();
      draftStore.saveDraft(target, {
        input: queued,
        attachments: [],
        modelId: selection.modelId,
        provider: selection.provider,
        reasoning: selection.reasoning,
      });
    }
  }
  if (parked && target !== pendingKey) draftStore.removeDraftAfterAttachmentTransfer(pendingKey);
}

/**
 * Clear the optimistic running mark a pre-admission death leaves behind. A
 * truthy turnExecutionId means a real turn was admitted meanwhile — a stale
 * pending entry must not detach a live turn.
 */
function clearOrphanedRunningMark(threadId: string): void {
  useThreadStore.setState((state) => {
    const record = state.records.get(threadId);
    if (record?.turnExecutionId) return state;
    const runningThreadIds = new Set(state.runningThreadIds);
    const marked = runningThreadIds.delete(threadId);
    const phase = record?.runtimePhase;
    const running = phase === "running" || phase === "finalizing";
    if (!marked && !running) return state;
    return {
      runningThreadIds,
      records: running
        ? patchThreadRecord(state.records, threadId, { runtimePhase: "idle" })
        : state.records,
    };
  });
}

const TERMINAL_STARTUP_STATES: ReadonlySet<ThreadStartup["state"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function reconcileBoundPlaceholder(startup: ThreadStartup, pendingKey: string | undefined): void {
  if (!startup.threadId || !pendingKey || pendingKey === startup.threadId) return;
  const ws = useWorkspaceStore.getState();
  if (ws.threads.some((thread) => thread.id === pendingKey && (thread.clientPreparing || thread.clientError))) {
    // A later binding push can now replace the unreconciled placeholder.
    void ws.recoverPreparingThreads();
  }
}

function stoppedBeforeAgentAdmission(startup: ThreadStartup): boolean {
  return startup.state === "cancelled"
    || startup.phase !== "agent" && (startup.state === "failed" || startup.state === "interrupted");
}

/** Holds authoritative startup records and their durable thread bindings. */
export const useThreadStartupStore = create<ThreadStartupState>((set, get) => ({
  recordsByStartupId: {},
  startupIdByThreadId: {},
  dismissedStartupIds: new Set<string>(),
  apply: (startup) => {
    // Reject stale records before side effects: recover() re-applies stored
    // terminal records on every lookup mount, and replaying them must not
    // disturb a thread whose runtime state has moved on.
    const current = get().recordsByStartupId[startup.startupId];
    if (current && current.revision >= startup.revision) return;
    set((state) => ({
      recordsByStartupId: {
        ...state.recordsByStartupId,
        [startup.startupId]: startup,
      },
      startupIdByThreadId: startup.threadId
        ? { ...state.startupIdByThreadId, [startup.threadId]: startup.startupId }
        : state.startupIdByThreadId,
    }));
    const ws = useWorkspaceStore.getState();
    const pendingKey = Object.keys(ws.pendingStartupByThreadId).find(
      (id) => ws.pendingStartupByThreadId[id]?.startupId === startup.startupId,
    );
    reconcileBoundPlaceholder(startup, pendingKey);
    // Blocked is a pause, not a resolution: approval or decline resumes the
    // same startup, so the pending entry must survive it.
    if (!TERMINAL_STARTUP_STATES.has(startup.state)) return;
    // The pending entry may still sit under the placeholder key when a terminal
    // push beats the creation response; match by startup id either way.
    // Before agent admission, the pending entry may be the last copy of the
    // first message, including when a restart interrupts checkout creation.
    if (pendingKey && stoppedBeforeAgentAdmission(startup)) {
      restoreUnsentDraft(startup, pendingKey);
    }
    ws.resolvePendingStartup({ threadId: startup.threadId, startupId: startup.startupId });
    // Only a pending entry owned by this startup proves the optimistic mark is
    // ours; foreign or historical terminal records must not touch a live turn.
    if (startup.state !== "completed" && pendingKey) clearOrphanedRunningMark(pendingKey);
  },
  dismissStartup: (startupId) => {
    set((state) => ({ dismissedStartupIds: new Set([...state.dismissedStartupIds, startupId]) }));
  },
  recover: async ({ startupId, workspaceId }) => {
    const transport = getTransport();
    const [record, list] = await Promise.all([
      startupId ? transport.getThreadStartup(startupId) : Promise.resolve(null),
      workspaceId ? transport.listThreadStartups(workspaceId) : Promise.resolve(null),
    ]);
    const store = useThreadStartupStore.getState();
    // listByWorkspace returns newest first; apply oldest to newest so the
    // threadId binding resolves to the latest record. The explicitly fetched
    // record applies last so its binding wins even against older list entries.
    for (const startup of [...(list?.records ?? [])].reverse()) store.apply(startup);
    if (record) store.apply(record);
  },
}));

/** Reads one startup and whether its current authoritative lookup is still resolving. */
export function useThreadStartupLookup({
  startupId,
  threadId,
  workspaceId,
  enabled = true,
}: {
  readonly startupId?: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly enabled?: boolean;
}): { readonly startup: ThreadStartup | undefined; readonly resolving: boolean } {
  const startup = useThreadStartupStore((state) => startupForThread(
    state.recordsByStartupId,
    state.startupIdByThreadId,
    startupId,
    threadId,
  ));
  const connectionStatus = useConnectionStore((state) => state.status);
  const canRecover = enabled && connectionStatus === "connected";
  const recoveryKey = `${startupId ?? ""}\u0000${threadId ?? ""}\u0000${workspaceId ?? ""}\u0000${canRecover}`;
  const [recovery, setRecovery] = useState(() => ({
    key: recoveryKey,
    resolved: !canRecover,
  }));
  const resolving = canRecover && (recovery.key !== recoveryKey || !recovery.resolved);

  useEffect(() => {
    if (!canRecover) return;
    let active = true;
    void useThreadStartupStore.getState().recover({ startupId, workspaceId })
      .catch(() => undefined)
      .finally(() => {
        if (active) setRecovery({ key: recoveryKey, resolved: true });
      });
    return () => {
      active = false;
    };

  }, [canRecover, recoveryKey, startupId, threadId, workspaceId]);

  return { startup, resolving };
}

/** Reads one startup by its client identity or its bound durable thread. */
export function useThreadStartup(input: {
  readonly startupId?: string;
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly enabled?: boolean;
}): ThreadStartup | undefined {
  return useThreadStartupLookup(input).startup;
}
