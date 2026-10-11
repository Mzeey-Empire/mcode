import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { WorkspaceEnvironmentAutomaticSetupSnapshot } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { ProjectCommandApprovalDialog } from "./ProjectCommandApprovalDialog";

type AutomaticSetupAction = "approve" | "continue" | "retry";
type AutomaticSetupAttempt = NonNullable<WorkspaceEnvironmentAutomaticSetupSnapshot["attempt"]>;
type AutomaticSetupAttemptState = AutomaticSetupAttempt["state"] | undefined;

interface AutomaticSetupActionState {
  readonly threadId: string;
  readonly busy: AutomaticSetupAction | null;
  readonly error: string | null;
}

const NO_AUTOMATIC_SETUP: WorkspaceEnvironmentAutomaticSetupSnapshot = {
  gate: "not-required",
  attempt: null,
  queuedTurns: [],
};

interface AutomaticSetupSnapshotState {
  readonly snapshotsByThread: Readonly<Record<string, WorkspaceEnvironmentAutomaticSetupSnapshot>>;
  readonly updateEpochByThread: Readonly<Record<string, number>>;
  hydrateSnapshot: (threadId: string, snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot, requestEpoch: number) => void;
  applySnapshot: (threadId: string, snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot) => void;
}

/** Holds the one automatic Setup snapshot that every surface reads for each Thread. */
export const useProjectAutomaticSetupStore = create<AutomaticSetupSnapshotState>((set, get) => ({
  snapshotsByThread: {},
  updateEpochByThread: {},
  hydrateSnapshot: (threadId, snapshot, requestEpoch) => {
    set((state) => (
      (state.updateEpochByThread[threadId] ?? 0) !== requestEpoch ? state : {
        snapshotsByThread: { ...state.snapshotsByThread, [threadId]: snapshot },
      }
    ));
    syncAutomaticSetupPoll(threadId, get().snapshotsByThread[threadId]);
  },
  applySnapshot: (threadId, snapshot) => {
    set((state) => ({
      snapshotsByThread: { ...state.snapshotsByThread, [threadId]: snapshot },
      updateEpochByThread: {
        ...state.updateEpochByThread,
        [threadId]: (state.updateEpochByThread[threadId] ?? 0) + 1,
      },
    }));
    syncAutomaticSetupPoll(threadId, snapshot);
  },
}));

function isAutomaticSetupActive(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot | undefined): boolean {
  const state = snapshot?.attempt?.state;
  return state === "queued" || state === "running";
}

// The poll belongs to the cached snapshot, not to a mounted row: a collapsed
// project and the palette still read this snapshot, so it must keep moving
// until setup settles even after every row that fetched it unmounts.
const automaticSetupPolls = new Map<string, number>();
const automaticSetupRequestSequence = new Map<string, number>();
const automaticSetupAppliedSequence = new Map<string, number>();

function syncAutomaticSetupPoll(threadId: string, snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot | undefined): void {
  const poll = automaticSetupPolls.get(threadId);
  if (!isAutomaticSetupActive(snapshot)) {
    if (poll !== undefined) window.clearInterval(poll);
    automaticSetupPolls.delete(threadId);
    return;
  }
  if (poll !== undefined) return;
  automaticSetupPolls.set(threadId, window.setInterval(() => {
    // A reset store drops the snapshot without passing through an action, so each tick rechecks.
    const current = useProjectAutomaticSetupStore.getState().snapshotsByThread[threadId];
    if (isAutomaticSetupActive(current)) void refreshAutomaticSetup(threadId);
    else syncAutomaticSetupPoll(threadId, current);
  }, 1_000));
}

/**
 * Fetches one Thread's automatic Setup snapshot into the shared store.
 * Drops a reply older than one already applied, or one that a user action superseded.
 * Resolves to null when the request fails.
 */
export async function refreshAutomaticSetup(threadId: string): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot | null> {
  const sequence = (automaticSetupRequestSequence.get(threadId) ?? 0) + 1;
  automaticSetupRequestSequence.set(threadId, sequence);
  const requestEpoch = useProjectAutomaticSetupStore.getState().updateEpochByThread[threadId] ?? 0;
  try {
    const next = await getTransport().getAutomaticSetup(threadId);
    if (sequence > (automaticSetupAppliedSequence.get(threadId) ?? 0)) {
      automaticSetupAppliedSequence.set(threadId, sequence);
      useProjectAutomaticSetupStore.getState().hydrateSnapshot(threadId, next, requestEpoch);
    }
    return next;
  } catch {
    return null;
  }
}

/** Reads and mutates one Thread's automatic Setup gate. */
export function useProjectAutomaticSetup(threadId: string, enabled = true) {
  const storedSnapshot = useProjectAutomaticSetupStore((state) => state.snapshotsByThread[threadId]);
  const snapshot = enabled ? storedSnapshot ?? NO_AUTOMATIC_SETUP : NO_AUTOMATIC_SETUP;
  const [actionState, setActionState] = useState<AutomaticSetupActionState>({ threadId, busy: null, error: null });
  const busy = actionState.threadId === threadId ? actionState.busy : null;
  const error = actionState.threadId === threadId ? actionState.error : null;
  const request = useRef(0);

  const refresh = useCallback(async (): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot | null> => {
    const current = request.current + 1;
    request.current = current;
    const next = await refreshAutomaticSetup(threadId);
    if (next === null && request.current === current) setActionState({ threadId, busy: null, error: "Could not refresh setup status" });
    return next;
  }, [threadId]);

  useEffect(() => {
    request.current += 1;
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const run = useCallback(async (
    action: AutomaticSetupAction,
    operation: () => Promise<WorkspaceEnvironmentAutomaticSetupSnapshot>,
    failureMessage: string,
  ) => {
    if (busy) return;
    setActionState({ threadId, busy: action, error: null });
    try {
      useProjectAutomaticSetupStore.getState().applySnapshot(threadId, await operation());
    } catch {
      setActionState({ threadId, busy: null, error: failureMessage });
    } finally {
      setActionState((current) => current.threadId === threadId ? { ...current, busy: null } : current);
    }
  }, [busy, threadId]);

  const continueWithoutSetup = useCallback(async () => {
    await run(
      "continue",
      () => getTransport().continueAutomaticSetup(threadId),
      "Could not continue without setup",
    );
  }, [run, threadId]);

  const retrySetup = useCallback(async () => {
    await run(
      "retry",
      () => getTransport().retryAutomaticSetup(threadId),
      "Could not retry setup",
    );
  }, [run, threadId]);

  const approveSetup = useCallback(async () => {
    const approval = snapshot.attempt?.snapshot?.approval;
    if (!approval) return;
    await run(
      "approve",
      async () => {
        await getTransport().approveWorkspaceEnvironmentCommand(threadId, approval.target, approval.fingerprint);
        return (await refresh()) ?? NO_AUTOMATIC_SETUP;
      },
      "Could not approve setup",
    );
  }, [refresh, run, snapshot.attempt?.snapshot?.approval, threadId]);

  return {
    snapshot,
    snapshotLoaded: !enabled || storedSnapshot !== undefined,
    busy,
    error,
    continueWithoutSetup,
    retrySetup,
    approveSetup,
  };
}

function getAutomaticSetupPresentation(state: AutomaticSetupAttemptState) {
  if (state === "failed") return { heading: "Environment setup failed", detail: null };
  if (state === "interrupted") return { heading: "Environment setup stopped", detail: null };
  if (state === "running") return { heading: "Setting up environment", detail: "Running setup before your first message." };
  return { heading: "Preparing environment", detail: "Setup will run before your first message." };
}

function AutomaticSetupHeader({ state }: { readonly state: AutomaticSetupAttemptState }) {
  const presentation = getAutomaticSetupPresentation(state);
  return (
    <header className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-sm font-medium">{presentation.heading}</h2>
        {presentation.detail ? <p className="mt-1 text-xs text-muted">{presentation.detail}</p> : null}
      </div>
      {state === "running" ? (
        <span role="status" className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          <Spinner size={12} aria-hidden />
          Running
        </span>
      ) : null}
    </header>
  );
}

function AutomaticSetupOutput({ attempt }: { readonly attempt: AutomaticSetupAttempt | null }) {
  const state = attempt?.state;
  const script = attempt?.snapshot?.script ?? "";
  const output = attempt?.output || (state === "running" ? "Waiting for setup output…" : "Waiting for setup to start…");
  return (
    <div aria-label="Environment setup terminal" className="mt-3 max-h-64 overflow-auto rounded-md border border-border/60 bg-background/60 p-3 font-mono text-xs leading-5">
      {script ? <pre className="whitespace-pre-wrap break-words text-ink">$ {script}</pre> : null}
      <pre className="whitespace-pre-wrap break-words text-muted">{output}</pre>
    </div>
  );
}

function AutomaticSetupRecoveryActions({ busy, onContinue, onRetry }: {
  readonly busy: AutomaticSetupAction | null;
  readonly onContinue: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
}) {
  return (
    <div className="mt-3 flex gap-2">
      <Button type="button" size="compact" disabled={busy !== null} onClick={() => { void onRetry(); }}>
        {busy === "retry" ? <Spinner size={12} aria-hidden /> : null}
        Retry setup
      </Button>
      <Button type="button" size="compact" variant="outline" disabled={busy !== null} onClick={() => { void onContinue(); }}>
        {busy === "continue" ? <Spinner size={12} aria-hidden /> : null}
        Continue without setup
      </Button>
    </div>
  );
}

function AutomaticSetupApproval({ attempt, onApprove }: {
  readonly attempt: AutomaticSetupAttempt;
  readonly onApprove?: () => Promise<void>;
}) {
  return (
    <ProjectCommandApprovalDialog
      approval={attempt.snapshot?.approval ?? null}
      script={attempt.snapshot?.script ?? null}
      onApprove={async () => {
        if (!onApprove) return false;
        await onApprove();
        return true;
      }}
      onCancel={() => undefined}
    />
  );
}

function AutomaticSetupAttemptCard({ attempt, busy, error, onContinue, onRetry }: {
  readonly attempt: AutomaticSetupAttempt | null;
  readonly busy: AutomaticSetupAction | null;
  readonly error: string | null;
  readonly onContinue: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
}) {
  const state = attempt?.state;
  const failed = state === "failed" || state === "interrupted";
  return (
    <section aria-label="Environment setup" className="mb-4 border-y border-border/60 py-4">
      <AutomaticSetupHeader state={state} />
      <AutomaticSetupOutput attempt={attempt} />
      {attempt?.outputTruncated ? <p className="mt-2 text-xs text-muted">Output was truncated.</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      {failed ? <AutomaticSetupRecoveryActions busy={busy} onContinue={onContinue} onRetry={onRetry} /> : null}
    </section>
  );
}

/** Renders the current blocking Setup attempt and its recovery actions. */
export function ProjectAutomaticSetupCard({
  snapshot,
  busy,
  error,
  onContinue,
  onRetry,
  onApprove,
}: {
  readonly snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot;
  readonly busy: AutomaticSetupAction | null;
  readonly error: string | null;
  readonly onContinue: () => Promise<void>;
  readonly onRetry: () => Promise<void>;
  readonly onApprove?: () => Promise<void>;
}) {
  if (snapshot.gate !== "blocked") return null;

  const attempt = snapshot.attempt;
  if (attempt?.state === "awaiting-approval") {
    return <AutomaticSetupApproval attempt={attempt} onApprove={onApprove} />;
  }

  return <AutomaticSetupAttemptCard attempt={attempt} busy={busy} error={error} onContinue={onContinue} onRetry={onRetry} />;
}
