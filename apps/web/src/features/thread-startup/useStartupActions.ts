import { useCallback, useEffect, useState } from "react";
import type { AgentModelState, ThreadStartup, ThreadStartupResolveInput, WorkspaceEnvironmentCommandApproval } from "@mcode/contracts";
import { useTerminalStore } from "@/features/terminal";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { type StartupCancelRequest, useThreadStartupStore } from "./state/thread-startup-store";

const TERMINAL_STATES: ReadonlySet<ThreadStartup["state"]> = new Set(["completed", "failed", "cancelled", "interrupted"]);
/** What the trail reads from a thread's automatic setup gate: the script text and any pending approval. */
export interface StartupSetupGate {
  readonly script: string | undefined;
  readonly approval: WorkspaceEnvironmentCommandApproval | undefined;
  /** Reads the gate again, for Run setup when the approval did not load. */
  readonly reload: () => void;
}

type LoadedSetupGate = Omit<StartupSetupGate, "reload"> & {
  readonly threadId: string;
  readonly setupState: string;
  readonly revision: number | undefined;
  readonly reads: number;
};

function setupStarted(setupState: string | undefined): setupState is string {
  return setupState !== undefined && setupState !== "pending";
}

/**
 * A running step reads again until its script arrives, since the step turns running before the
 * attempt records it. A blocked step reads again on every revision, so the approval Run setup
 * sends always matches the script on screen.
 */
function gateIsCurrent(loaded: LoadedSetupGate | null, setupState: string | undefined, revision: number | undefined, reads: number): boolean {
  if (loaded === null || loaded.setupState !== setupState || loaded.reads !== reads) return false;
  if (setupState === "blocked") return loaded.revision === revision;
  return setupState !== "running" || loaded.script !== undefined || loaded.revision === revision;
}

/**
 * Reads the setup script for the setup row and the approval behind a Setup needs approval block.
 *
 * The startup record carries neither, so this reads the automatic setup gate when the setup step
 * changes, when the connection returns after a failed read, and when the user asks again. Nothing
 * here runs on a timer.
 */
export function useStartupSetupGate(startup: ThreadStartup | undefined): StartupSetupGate {
  const threadId = startup?.threadId;
  const setupState = startup?.steps.find((step) => step.phase === "setup")?.state;
  const revision = startup?.revision;
  const connected = useConnectionStore((state) => state.status === "connected");
  const [loaded, setLoaded] = useState<LoadedSetupGate | null>(null);
  const [reads, setReads] = useState(0);
  const current = loaded?.threadId === threadId ? loaded : null;
  const settled = gateIsCurrent(current, setupState, revision, reads);
  useEffect(() => {
    // A read that failed while offline is not settled, so the reconnect below reads again.
    if (!threadId || !setupStarted(setupState) || settled) return;
    let active = true;
    getTransport().getAutomaticSetup(threadId).then(
      (snapshot) => {
        if (!active) return;
        const attempt = snapshot.attempt?.snapshot;
        setLoaded({ threadId, setupState, revision, reads, script: attempt?.script ?? undefined, approval: attempt?.approval ?? undefined });
      },
      (error: unknown) => {
        // Background reads only label rows; a failed read the user asked for says why.
        if (active && reads > 0) showFailure("Could not load the setup command", error);
      },
    );
    return () => {
      active = false;
    };
  }, [threadId, setupState, revision, settled, connected, reads]);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  return { script: current?.script, approval: current?.approval, reload };
}

/** One decision a startup stopped at setup can take. */
export type SetupDecisionAction = "retry" | "skip" | "approve";

/** Retry setup, Skip setup and Run setup for a startup stopped at its setup step. */
export interface StartupSetupDecision {
  /** The action on its way to the server; every action stays disabled until it settles. */
  readonly pending: SetupDecisionAction | null;
  readonly run: (action: SetupDecisionAction) => void;
}

const SETUP_DECISION_FAILURE: Record<SetupDecisionAction, string> = {
  retry: "Could not retry setup",
  skip: "Could not skip setup",
  approve: "Could not run setup",
};

function sendSetupDecision(threadId: string, action: SetupDecisionAction, approval: WorkspaceEnvironmentCommandApproval | undefined): Promise<unknown> {
  const transport = getTransport();
  switch (action) {
    case "retry":
      return transport.retryAutomaticSetup(threadId);
    case "skip":
      return transport.continueAutomaticSetup(threadId);
    case "approve":
      if (!approval) return Promise.reject(new Error("The setup command to approve is not loaded"));
      return transport.approveWorkspaceEnvironmentCommand(threadId, approval.target, approval.fingerprint);
  }
}

function showFailure(title: string, error: unknown): void {
  useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : undefined });
}

/**
 * Sends one setup decision for a thread. The startup push that follows moves the trail, so a
 * success needs no local state; a failure leaves the trail where it was and says why.
 */
export function useStartupSetupDecision(threadId: string, approval: WorkspaceEnvironmentCommandApproval | undefined): StartupSetupDecision {
  const [pending, setPending] = useState<SetupDecisionAction | null>(null);
  const run = useCallback((action: SetupDecisionAction) => {
    setPending(action);
    sendSetupDecision(threadId, action, approval)
      .catch((error: unknown) => showFailure(SETUP_DECISION_FAILURE[action], error))
      .finally(() => setPending(null));
  }, [approval, threadId]);
  return { pending, run };
}

/** The thread's first turn while it is the only one and errored, which is the turn Thread didn't start retries. */
function soleErroredTurnId(state: AgentModelState, threadId: string): string | undefined {
  const turns = Object.values(state.turns).filter((turn) => turn.threadId === threadId);
  return turns.length === 1 && turns[0]!.status === "Errored" ? turns[0]!.id : undefined;
}

/** Retry for a startup whose agent failed before it answered. */
export interface StartupTurnRetry {
  readonly pending: boolean;
  readonly retry: () => void;
}

/**
 * Retries the thread's first turn through the same server path as a turn ending's Retry.
 *
 * The server retries only an errored latest attempt, so an agent phase that ended any other way,
 * or a turn already retried, offers nothing.
 */
export function useStartupTurnRetry(threadId: string): StartupTurnRetry | undefined {
  const turnId = useThreadRecord(threadId, (record) => soleErroredTurnId(record.canonicalAgent.state, threadId));
  const [pending, setPending] = useState(false);
  const retry = useCallback(() => {
    if (!turnId) return;
    setPending(true);
    getTransport().retryErroredTurn({ threadId, turnId })
      .catch((error: unknown) => showFailure("Could not retry the thread", error))
      .finally(() => setPending(false));
  }, [threadId, turnId]);
  return turnId ? { pending, retry } : undefined;
}

/**
 * Cancels a live startup from the trail, the composer Stop and Esc.
 *
 * Returns no callback once the startup has ended or a cancellation is in flight. A request that failed
 * offers the callback again, even though the server already holds the intent: a failed agent stop or
 * transport error can succeed on retry. A failed setup containment cannot; the retry reports it again.
 */
export function useStartupCancel(startup: ThreadStartup | undefined, startupId: string | undefined): (() => void) | undefined {
  const id = startup?.startupId ?? startupId;
  const ownRequest = useThreadStartupStore((state) => (id ? state.cancelRequestByStartupId[id] : undefined));
  const cancel = useCallback(() => {
    if (!id) return;
    const store = useThreadStartupStore.getState();
    store.setCancelRequest(id, "in-flight");
    getTransport().cancelThreadStartup(id).then(
      (next) => store.apply(next),
      (error: unknown) => {
        store.setCancelRequest(id, "failed");
        useToastStore.getState().show({
          kind: "failed",
          title: "Could not cancel startup",
          meta: error instanceof Error ? error.message : undefined,
        });
      },
    );
  }, [id]);
  if (!id) return undefined;
  return canOfferCancel(startup, ownRequest) ? cancel : undefined;
}

function canOfferCancel(startup: ThreadStartup | undefined, ownRequest: StartupCancelRequest | undefined): boolean {
  if (startup && TERMINAL_STATES.has(startup.state)) return false;
  if (ownRequest) return ownRequest === "failed";
  return startup?.cancellation !== "requested";
}

type FetchDecision = ThreadStartupResolveInput["action"];

/** Retry and Continue for a startup blocked because Start from origin could not fetch its branch. */
export interface StartupFetchDecision {
  /** The decision on its way to the server; both actions stay disabled until it settles. */
  readonly pending: FetchDecision | null;
  readonly resolve: (action: FetchDecision) => void;
  /** The local branch the worktree falls back to when the user continues without the fetch. */
  readonly localBranch: string;
}

function fetchLocalBranch(startup: ThreadStartup | undefined): string | undefined {
  const detail = startup?.steps.find((step) => step.phase === "fetch")?.detail;
  if (detail?.phase !== "fetch") return undefined;
  return detail.branch ?? detail.ref.replace(/^origin\//, "");
}

/**
 * Offers the fetch decision only while the startup is blocked on a failed origin fetch.
 *
 * The server records the fetch step's ref and branch before it blocks, so a block without
 * that detail offers no decision instead of guessing which local branch to start from.
 */
export function useStartupFetchDecision(startup: ThreadStartup | undefined): StartupFetchDecision | undefined {
  const [pending, setPending] = useState<FetchDecision | null>(null);
  const id = startup?.startupId;
  const localBranch = fetchLocalBranch(startup);
  const resolve = useCallback((action: FetchDecision) => {
    if (!id) return;
    setPending(action);
    getTransport().resolveThreadStartup(id, action).then(
      (next) => useThreadStartupStore.getState().apply(next),
      (error: unknown) => {
        useToastStore.getState().show({
          kind: "failed",
          title: action === "retry" ? "Could not retry the fetch" : `Could not start from local ${localBranch}`,
          meta: error instanceof Error ? error.message : undefined,
        });
      },
    ).finally(() => setPending(null));
  }, [id, localBranch]);
  const blocked = startup?.state === "blocked" && startup.phase === "fetch" && startup.block?.code === "start_from_origin_failed";
  return blocked && localBranch !== undefined ? { pending, resolve, localBranch } : undefined;
}

/**
 * The composer's starting state, present while the thread's startup has not ended.
 *
 * Before the record arrives, a pending startup counts as starting.
 */
export function useStartingThread(
  startup: ThreadStartup | undefined,
  pending: { readonly startupId: string } | undefined,
): { readonly onCancel: (() => void) | undefined } | undefined {
  const onCancel = useStartupCancel(startup, pending?.startupId);
  if (startup ? TERMINAL_STATES.has(startup.state) : !pending) return undefined;
  return { onCancel };
}

/** Opens the automatic setup terminal for a thread in its right panel. */
export async function openStartupSetupTerminal(workspaceId: string, threadId: string): Promise<void> {
  try {
    const { ptyId, shell } = await getTransport().openAutomaticSetupTerminal(threadId);
    showRightPanelAdaptive(workspaceId, threadId);
    useTerminalStore.getState().addTerminal(threadId, ptyId, shell);
    useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "terminal");
  } catch (error) {
    useToastStore.getState().show({
      kind: "failed",
      title: "Could not open setup terminal",
      meta: error instanceof Error ? error.message : undefined,
    });
  }
}

/** Opens Project settings on the environment tab, where the setup script is edited. */
export function editStartupSetupScript(workspaceId: string, threadId: string): void {
  showRightPanelAdaptive(workspaceId, threadId);
  useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "environment");
}
