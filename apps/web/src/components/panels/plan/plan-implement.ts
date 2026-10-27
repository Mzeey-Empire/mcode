import { create } from "zustand";
import { PlanVersionSchema, type PlanImplement, type PlanVersion } from "@mcode/contracts/models/plan";
import { getTransport, INTERACTION_MODES } from "@/transport";
import { RpcError } from "@/transport/ws-transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { selectViewedPlanVersion, usePlanStore } from "@/stores/planStore";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { planSaveScheduler } from "./plan-draft-sessions";
import type { ImplementOutcome, ImplementPick } from "./plan-save-scheduler";

/** Shown when the version changed under an Implement that carried no edits. */
export const PLAN_CHANGED_NOTICE = "This version changed in another window. Nothing was sent.";
/** Shown when an Implement request failed or the server restarted before admitting it. */
export const IMPLEMENT_FAILED_NOTICE = "Implement was interrupted. Nothing was sent.";

interface PlanImplementState {
  /** Threads with an Implement request between the press and its outcome. */
  readonly busy: Readonly<Record<string, true>>;
  readonly notices: Readonly<Record<string, string>>;
  /** Threads whose Plan panel is showing, so Implement targets the version on screen. */
  readonly panelsOnScreen: Readonly<Record<string, true>>;
}

/** Per-thread Implement progress and the notice its last outcome left. */
export const usePlanImplementStore = create<PlanImplementState>(() => ({ busy: {}, notices: {}, panelsOnScreen: {} }));

function withEntry<V>(record: Readonly<Record<string, V>>, threadId: string, value: V | null): Record<string, V> {
  const next = { ...record };
  if (value === null) delete next[threadId];
  else next[threadId] = value;
  return next;
}

function setBusy(threadId: string, busy: boolean): void {
  usePlanImplementStore.setState((s) => ({ busy: withEntry(s.busy, threadId, busy ? true : null) }));
}

function setNotice(threadId: string, notice: string | null): void {
  usePlanImplementStore.setState((s) => ({ notices: withEntry(s.notices, threadId, notice) }));
}

/** Marks the thread's Plan panel as on screen until the returned cleanup runs. */
export function showPlanPanel(threadId: string): () => void {
  usePlanImplementStore.setState((s) => ({ panelsOnScreen: withEntry(s.panelsOnScreen, threadId, true) }));
  return () => usePlanImplementStore.setState((s) => ({ panelsOnScreen: withEntry(s.panelsOnScreen, threadId, null) }));
}

/** Clears the notice an earlier Implement left on the thread. */
export function dismissImplementNotice(threadId: string): void {
  if (usePlanImplementStore.getState().notices[threadId] !== undefined) setNotice(threadId, null);
}

/** Whether a version can be implemented: accepted and superseded versions are history. */
export function isPlanVersionImplementable(version: PlanVersion): boolean {
  return version.status === "draft" || version.status === "ready";
}

/**
 * The version Implement acts on: the one on screen while the Plan panel shows,
 * otherwise the newest version. Null when that version is not implementable.
 */
export function selectImplementTarget(
  versions: readonly PlanVersion[],
  activeVersion: number | null,
  panelOnScreen: boolean,
): PlanVersion | null {
  const target = panelOnScreen ? selectViewedPlanVersion(versions, activeVersion) : (versions.at(-1) ?? null);
  return target !== null && isPlanVersionImplementable(target) ? target : null;
}

function currentTarget(threadId: string): ImplementPick | null {
  const { plansByThread, activeVersionByThread } = usePlanStore.getState();
  const versions = plansByThread[threadId] ?? [];
  const onScreen = usePlanImplementStore.getState().panelsOnScreen[threadId] === true;
  const target = selectImplementTarget(versions, activeVersionByThread[threadId] ?? null, onScreen);
  const latest = versions.at(-1);
  return target && latest ? { target, latest } : null;
}

function untilConnected(): Promise<void> {
  if (useConnectionStore.getState().status === "connected") return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useConnectionStore.subscribe((state) => {
      if (state.status !== "connected") return;
      unsubscribe();
      resolve();
    });
  });
}

function classifyImplementFailure(error: unknown): Exclude<ImplementOutcome, { kind: "admitted" }> {
  const parsed = error instanceof RpcError ? PlanVersionSchema().safeParse(error.data?.latestVersion) : null;
  const latest = parsed?.success ? parsed.data : null;
  const changed = error instanceof RpcError && (error.code === "plan_conflict" || error.code === "plan_read_only");
  return changed && latest ? { kind: "conflict", latest } : { kind: "failed", latest };
}

function mirrorAdmittedBuildMode(threadId: string): void {
  useThreadStore.getState().applyPersistedThreadSettings(threadId, { interactionMode: INTERACTION_MODES.BUILD });
}

function isConnectionDrop(error: unknown): boolean {
  return error instanceof Error && !(error instanceof RpcError) && error.message === "WebSocket disconnected";
}

/*
 * A new-worktree Implement ends its hold through a push, a snapshot read or never reaches this client
 * as a push at all, so the source's switch to Build follows the store transition rather than any one
 * of those paths. Only the initiating press mirrors an immediate admission.
 */
usePlanStore.subscribe((state, previous) => {
  if (state.pendingImplementByThread === previous.pendingImplementByThread) return;
  for (const [threadId, held] of Object.entries(previous.pendingImplementByThread)) {
    if (state.pendingImplementByThread[threadId]) continue;
    const version = state.plansByThread[threadId]?.find((candidate) => candidate.version === held.version);
    if (version?.status === "accepted") mirrorAdmittedBuildMode(threadId);
  }
});

function mayReplay(target: PlanImplement["target"], alreadyReplayed: boolean): boolean {
  return target === "thread" || !alreadyReplayed;
}

type ImplementResult =
  | Exclude<ImplementOutcome, { kind: "admitted" }>
  | { kind: "admitted"; targetThreadId: string; version: number; waitingForSetup: boolean };

async function sendImplementWithReplay(request: PlanImplement): Promise<ImplementResult> {
  let replayed = false;
  while (true) {
    try {
      const receipt = await getTransport().implementPlan(request);
      return {
        kind: "admitted",
        targetThreadId: receipt.targetThreadId,
        version: receipt.version,
        waitingForSetup: receipt.state === "waiting-for-setup",
      };
    } catch (error) {
      if (!isConnectionDrop(error) || !mayReplay(request.target, replayed)) return classifyImplementFailure(error);
    }
    replayed = true;
    // A closing socket rejects before its close event marks the connection
    // lost, so the status can still read connected until a later task runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await untilConnected();
  }
}

/**
 * Implements the thread's target version in the selected destination. Waits for an
 * in-flight autosave, carries unsent edits in the request, and reports a
 * changed version or a failure as a notice. A second press while one runs
 * does nothing.
 */
export async function implementPlan(threadId: string, target: PlanImplement["target"] = "thread"): Promise<void> {
  if (usePlanImplementStore.getState().busy[threadId]) return;
  setBusy(threadId, true);
  dismissImplementNotice(threadId);
  try {
    const scheduler = planSaveScheduler(threadId);
    const basis = await scheduler.beginImplement(() => currentTarget(threadId));
    if (!basis) return;
    const carried = basis.pending !== undefined;
    const applyReceiptHold = usePlanStore.getState().beginPendingImplementRead(threadId);
    const outcome = await sendImplementWithReplay({ requestId: crypto.randomUUID(), threadId, target, ...basis });
    scheduler.finishImplement(outcome);
    if (outcome.kind === "admitted") {
      // The source stays in Plan until the target's first turn is admitted behind Setup.
      if (outcome.waitingForSetup) {
        applyReceiptHold({ targetThreadId: outcome.targetThreadId, version: outcome.version });
      } else {
        mirrorAdmittedBuildMode(threadId);
      }
      if (target !== "thread") await openImplementedThread(threadId, outcome.targetThreadId);
    } else if (outcome.kind === "conflict" && !carried) {
      usePlanStore.getState().setActiveVersion(threadId, null);
      setNotice(threadId, PLAN_CHANGED_NOTICE);
    } else if (outcome.kind === "failed") {
      setNotice(threadId, IMPLEMENT_FAILED_NOTICE);
    }
  } finally {
    setBusy(threadId, false);
  }
}

async function openImplementedThread(sourceThreadId: string, targetThreadId: string): Promise<void> {
  const workspace = useWorkspaceStore.getState();
  const source = workspace.threads.find(thread => thread.id === sourceThreadId);
  if (source) {
    if (!workspace.threads.some(thread => thread.id === targetThreadId)) await workspace.hydrateThreads();
    workspace.setActiveWorkspace(source.workspace_id);
  }
  workspace.setActiveThread(targetThreadId);
}
