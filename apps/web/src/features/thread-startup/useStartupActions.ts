import { useCallback, useMemo, useState } from "react";
import type { AgentModelState, ThreadStartup, ThreadStartupResolveInput, WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { approveAndStartAction } from "@/features/projects/actions/approveAndStartAction";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore } from "@/features/terminal";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { useDiffStore } from "@/stores/diffStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { type StartupCancelRequest, useThreadStartupStore } from "./state/thread-startup-store";
import { startupSetupView, type StartupSetupView } from "./startup-step-copy";

const TERMINAL_STATES: ReadonlySet<ThreadStartup["state"]> = new Set(["completed", "failed", "cancelled", "interrupted"]);
const NO_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

/** The setup step's startup actions joined with their retained runs. */
export function useStartupSetupView(startup: ThreadStartup | undefined): StartupSetupView {
  const threadId = startup?.threadId;
  const detail = startup?.steps.find((step) => step.phase === "setup")?.detail;
  const actions = detail?.phase === "setup" ? detail.actions : undefined;
  const runs = useProjectActionStore((state) => (threadId ? state.runsByThread[threadId] : undefined)) ?? NO_RUNS;
  return useMemo(() => startupSetupView(actions ?? [], runs), [actions, runs]);
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

function sendSetupDecision(threadId: string, action: SetupDecisionAction, pending: WorkspaceEnvironmentActionRun | undefined): Promise<unknown> {
  const transport = getTransport();
  switch (action) {
    case "retry":
      return transport.retryAutomaticSetup(threadId);
    case "skip":
      return transport.continueAutomaticSetup(threadId);
    case "approve":
      if (!pending) return Promise.reject(new Error("The setup command to approve is not loaded"));
      return approveAndStartAction(pending).then((started) => {
        if (!started) throw new Error("The pending setup terminal was closed");
      });
  }
}

function showFailure(title: string, error: unknown): void {
  useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : undefined });
}

/**
 * Sends one setup decision for a thread. The startup push that follows moves the trail, so a
 * success needs no local state; a failure leaves the trail where it was and says why.
 */
export function useStartupSetupDecision(threadId: string, pending: WorkspaceEnvironmentActionRun | undefined): StartupSetupDecision {
  const [inFlight, setInFlight] = useState<SetupDecisionAction | null>(null);
  const run = useCallback((action: SetupDecisionAction) => {
    setInFlight(action);
    sendSetupDecision(threadId, action, pending)
      .catch((error: unknown) => showFailure(SETUP_DECISION_FAILURE[action], error))
      .finally(() => setInFlight(null));
  }, [pending, threadId]);
  return { pending: inFlight, run };
}

type ThreadTurnShape = { readonly kind: "none" } | { readonly kind: "sole-errored"; readonly turnId: string } | { readonly kind: "other" };

function threadTurnShape(state: AgentModelState, threadId: string): ThreadTurnShape {
  const turns = Object.values(state.turns).filter((turn) => turn.threadId === threadId);
  if (turns.length === 0) return { kind: "none" };
  return turns.length === 1 && turns[0]!.status === "Errored" ? { kind: "sole-errored", turnId: turns[0]!.id } : { kind: "other" };
}

type AgentRetryTarget = { readonly kind: "turn"; readonly turnId: string } | { readonly kind: "unsent"; readonly startupId: string };

/**
 * An errored first turn retries through the turn path. With no turn at all, only a managed worktree
 * start kept its first message in the setup queue, so only it has something the server can resend.
 */
function agentRetryTarget(startup: Pick<ThreadStartup, "kind" | "startupId">, shape: ThreadTurnShape): AgentRetryTarget | undefined {
  if (shape.kind === "sole-errored") return { kind: "turn", turnId: shape.turnId };
  if (shape.kind === "none" && startup.kind === "managed-worktree") return { kind: "unsent", startupId: startup.startupId };
  return undefined;
}

function sendAgentRetry(threadId: string, target: AgentRetryTarget): Promise<unknown> {
  if (target.kind === "turn") return getTransport().retryErroredTurn({ threadId, turnId: target.turnId });
  return getTransport().retryThreadStartupAgent(target.startupId).then((next) => useThreadStartupStore.getState().apply(next));
}

/** Retry for a startup whose agent failed before it answered. */
export interface StartupAgentRetry {
  readonly pending: boolean;
  readonly retry: () => void;
}

/**
 * Retries a startup whose agent failed. An errored first turn goes through the same server path
 * as a turn ending's Retry. A managed worktree start that failed before any turn existed asks the
 * server to resend the first message it saved during setup.
 *
 * A turn already retried, or an agent phase that ended any other way, offers nothing.
 */
export function useStartupAgentRetry(startup: ThreadStartup, threadId: string): StartupAgentRetry | undefined {
  const shape = useThreadRecord(threadId, (record) => threadTurnShape(record.canonicalAgent.state, threadId));
  const { kind, startupId } = startup;
  const target = useMemo(() => agentRetryTarget({ kind, startupId }, shape), [kind, startupId, shape]);
  const [pending, setPending] = useState(false);
  const retry = useCallback(() => {
    if (!target) return;
    setPending(true);
    sendAgentRetry(threadId, target)
      .catch((error: unknown) => showFailure("Could not retry the thread", error))
      .finally(() => setPending(false));
  }, [threadId, target]);
  return target ? { pending, retry } : undefined;
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

/** Shows one startup action's terminal in the thread's right panel. */
export function openStartupSetupTerminal(workspaceId: string, threadId: string, terminalSessionId: string): void {
  showRightPanelAdaptive(workspaceId, threadId);
  useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "terminal");
  useTerminalStore.getState().setActiveTerminal(threadId, terminalSessionId);
}

/** Opens Project settings on the environment tab, where the setup script is edited. */
export function editStartupSetupScript(workspaceId: string, threadId: string): void {
  showRightPanelAdaptive(workspaceId, threadId);
  useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "environment");
}
