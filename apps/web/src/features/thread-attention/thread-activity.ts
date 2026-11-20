import type { ThreadStartup, ThreadStartupPhase } from "@mcode/contracts/thread-startup";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { startupDecision } from "@/features/thread-startup/startup-step-copy";
import { useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";

/** A thread's startup, read the same way everywhere. Server record wins; local placeholder only until it exists. */
export type StartupActivity =
  | { readonly kind: "none" }
  | { readonly kind: "setting-up"; readonly phase: ThreadStartupPhase | null }
  | { readonly kind: "needs-you"; readonly decision: "setup-approval" | "setup-failed" | "fetch-failed" }
  | { readonly kind: "failed" };

/** What one thread is doing now. Every surface reads this. */
export interface ThreadActivity {
  readonly startup: StartupActivity;
  /** The thread's own turn runs, by the Send button's check (`isThreadExecuting`). */
  readonly turnRunning: boolean;
}

/** The facts one thread's activity is derived from. */
export interface ThreadActivityFacts {
  readonly record: ThreadStartup | undefined;
  readonly local: { readonly preparing: boolean; readonly pendingStartup: boolean; readonly createFailed: boolean };
  readonly turnRunning: boolean;
}

/** The startup maps a thread reads its record from, as held by the thread startup store. */
export type ThreadStartupMaps = Pick<ReturnType<typeof useThreadStartupStore.getState>, "recordsByStartupId" | "startupIdByThreadId">;

/** A thread's startup record, if this client has one. */
export function threadStartupRecord(state: ThreadStartupMaps, threadId: string): ThreadStartup | undefined {
  const startupId = state.startupIdByThreadId[threadId];
  return startupId ? state.recordsByStartupId[startupId] : undefined;
}

const NONE: StartupActivity = { kind: "none" };
const FAILED: StartupActivity = { kind: "failed" };

function blockedActivity(record: ThreadStartup): StartupActivity {
  const decision = startupDecision(record);
  if (decision === "setup-approval" || decision === "fetch-failed") return { kind: "needs-you", decision };
  return { kind: "needs-you", decision: "setup-failed" };
}

// The seen mark lives on the record, so a failure stays until any window has shown it.
function unseenFailureActivity(record: ThreadStartup): StartupActivity {
  return record.failureSeenAt === null ? FAILED : NONE;
}

function recordActivity(record: ThreadStartup): StartupActivity {
  switch (record.state) {
    case "pending":
    case "running":
      return { kind: "setting-up", phase: record.phase };
    case "blocked":
      return blockedActivity(record);
    case "interrupted":
      // The server can retry or skip an interrupted setup, so it waits on the user like a failed one.
      return record.phase === "setup" ? { kind: "needs-you", decision: "setup-failed" } : unseenFailureActivity(record);
    case "failed":
      return unseenFailureActivity(record);
    case "completed":
    case "cancelled":
      return NONE;
  }
}

function localActivity(local: ThreadActivityFacts["local"]): StartupActivity {
  if (local.createFailed) return FAILED;
  return local.preparing || local.pendingStartup ? { kind: "setting-up", phase: null } : NONE;
}

/** Picks a thread's activity. The server record outranks the local placeholder as soon as it exists. */
export function deriveThreadActivity(facts: ThreadActivityFacts): ThreadActivity {
  return {
    startup: facts.record ? recordActivity(facts.record) : localActivity(facts.local),
    turnRunning: facts.turnRunning,
  };
}

/** Startup holds the composer, Close, Retry and the scaffold dim. */
export function startupHolds(activity: ThreadActivity): boolean {
  return activity.startup.kind === "setting-up" || activity.startup.kind === "needs-you";
}

type LocalFlags = Partial<ThreadActivityFacts["local"]>;

/** Subscribes to one thread's activity; the row re-renders only when its own facts change. */
export function useThreadActivity(threadId: string, local: LocalFlags = {}): ThreadActivity {
  const record = useThreadStartupStore((state) => threadStartupRecord(state, threadId));
  const pendingStartup = useWorkspaceStore((state) => state.pendingStartupByThreadId[threadId] !== undefined);
  const turnRunning = useThreadStore((state) => isThreadExecuting(threadId, state));
  const { preparing = false, createFailed = false } = local;
  return deriveThreadActivity({ record, local: { preparing, pendingStartup, createFailed }, turnRunning });
}

/** Reads one thread's activity outside React from the same facts as {@link useThreadActivity}. */
export function readThreadActivity(threadId: string, local: LocalFlags = {}): ThreadActivity {
  const { preparing = false, createFailed = false } = local;
  return deriveThreadActivity({
    record: threadStartupRecord(useThreadStartupStore.getState(), threadId),
    local: { preparing, pendingStartup: useWorkspaceStore.getState().pendingStartupByThreadId[threadId] !== undefined, createFailed },
    turnRunning: isThreadExecuting(threadId, useThreadStore.getState()),
  });
}
