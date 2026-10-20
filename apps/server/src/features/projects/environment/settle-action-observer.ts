import * as NodeFSPromises from "node:fs/promises";
import { logger } from "@mcode/shared";
import { actionSchedule } from "@mcode/contracts";
import type { CanonicalAgentEventEnvelope, WorkspaceEnvironmentAction } from "@mcode/contracts";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";
import type { ProjectActionService } from "./project-action-service.js";

/**
 * Wait before acting on a completed Turn. The composer queue drains about 400 ms after completion,
 * so a thread that is about to start its next Turn must have time to show as busy again.
 */
export const SETTLE_DELAY_MS = 1_000;

/** Executions remembered for de-duplication. Bounded so a long-lived server cannot grow without limit. */
const SEEN_EXECUTIONS_MAX = 1_024;

/** Thread facts needed to decide where, and whether, a settle run may start. */
export interface SettleActionThread {
  readonly id: string;
  readonly workspace_id: string;
  readonly mode: string;
  readonly worktree_path?: string | null;
  readonly deleted_at?: string | null;
  readonly user_completed_at?: string | null;
}

/** Timer boundary, replaceable so tests advance time without sleeping. `set` returns its own canceller. */
export type SettleTimers = (callback: () => void, delayMs: number) => () => void;

/** Collaborators of {@link SettleActionObserver}. */
export interface SettleActionObserverOptions {
  readonly subscribe: (listener: (events: readonly CanonicalAgentEventEnvelope[]) => void) => () => void;
  readonly threads: { findById(id: string): SettleActionThread | null };
  readonly runningThreadIds: () => readonly string[];
  readonly isWaiting: (threadId: string) => boolean;
  readonly environment: {
    read(workspaceId: string, threadId: string): Promise<{ readonly document: { readonly actions: readonly WorkspaceEnvironmentAction[] } }>;
  };
  readonly actions: Pick<ProjectActionService, "launch">;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly timers?: SettleTimers;
  readonly delayMs?: number;
}

const systemTimers: SettleTimers = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  handle.unref();
  return () => { clearTimeout(handle); };
};

/**
 * Runs every `runOnSettle` Project Action after a Turn completes and the thread stays quiet.
 *
 * Settle is unattended, so it never asks for approval: an unapproved shared command is skipped, and a
 * run waiting for approval is left alone. Runs are recorded as `manual` because only the Setup gate
 * owns `startup` runs. An action still running from the previous Turn is restarted.
 */
export class SettleActionObserver {
  private unsubscribe: (() => void) | null = null;
  private readonly seenExecutions = new Set<string>();
  private readonly timers = new Map<string, () => void>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly warned = new Set<string>();
  private readonly timerApi: SettleTimers;
  private readonly delayMs: number;
  private readonly pathExists: (path: string) => Promise<boolean>;

  constructor(private readonly options: SettleActionObserverOptions) {
    this.timerApi = options.timers ?? systemTimers;
    this.delayMs = options.delayMs ?? SETTLE_DELAY_MS;
    this.pathExists = options.pathExists ?? defaultPathExists;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.subscribe((events) => {
      for (const event of events) {
        if (event.payload.type !== "turn.completed") continue;
        if (!this.remember(event.routing.executionId)) continue;
        this.schedule(event.routing.threadId);
      }
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    await Promise.all(this.inFlight);
  }

  private remember(executionId: string): boolean {
    if (this.seenExecutions.has(executionId)) return false;
    this.seenExecutions.add(executionId);
    if (this.seenExecutions.size > SEEN_EXECUTIONS_MAX) {
      const oldest = this.seenExecutions.values().next().value;
      if (oldest !== undefined) this.seenExecutions.delete(oldest);
    }
    return true;
  }

  private schedule(threadId: string): void {
    this.timers.get(threadId)?.();
    this.timers.set(threadId, this.timerApi(() => {
      this.timers.delete(threadId);
      const operation = this.settle(threadId).catch((error: unknown) => {
        logger.error("Run on settle failed", { threadId, error: error instanceof Error ? error.message : String(error) });
      });
      this.inFlight.add(operation);
      void operation.then(() => { this.inFlight.delete(operation); });
    }, this.delayMs));
  }

  private isIdle(threadId: string): boolean {
    return !this.options.runningThreadIds().includes(threadId) && !this.options.isWaiting(threadId);
  }

  private async settle(threadId: string): Promise<void> {
    if (!this.isIdle(threadId)) return;
    const thread = this.options.threads.findById(threadId);
    if (!thread || thread.deleted_at || thread.user_completed_at) return;
    const actions = await this.settleActions(thread);
    if (actions.length === 0 || !(await this.checkoutExists(thread, actions))) return;
    for (const action of actions) {
      if (!this.isIdle(threadId)) return;
      await this.launch(thread.id, action);
    }
  }

  /** A worktree thread whose directory was removed has nowhere to run; say so once per action. */
  private async checkoutExists(thread: SettleActionThread, actions: readonly WorkspaceEnvironmentAction[]): Promise<boolean> {
    if (thread.mode !== "worktree") return true;
    if (thread.worktree_path && await this.pathExists(thread.worktree_path)) return true;
    for (const action of actions) this.warnOnce(thread.id, action.id, "worktree is gone");
    return false;
  }

  private async settleActions(thread: SettleActionThread): Promise<WorkspaceEnvironmentAction[]> {
    try {
      const { document } = await this.options.environment.read(thread.workspace_id, thread.id);
      return document.actions.filter((action) => actionSchedule(action).settle);
    } catch (error) {
      this.warnOnce(thread.id, "*", `environment unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async launch(threadId: string, action: WorkspaceEnvironmentAction): Promise<void> {
    try {
      const run = await this.options.actions.launch(
        { threadId, actionId: action.id },
        { trigger: "manual", skipUnapproved: true },
      );
      if (!run) this.warnOnce(threadId, action.id, "command is not approved");
    } catch (error) {
      if (error instanceof WorkspaceEnvironmentServiceError) {
        this.warnOnce(threadId, action.id, error.message);
        return;
      }
      logger.error("Run on settle failed", {
        threadId, actionId: action.id, error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** A skipped action would otherwise log after every Turn, so each reason is reported once per process. */
  private warnOnce(threadId: string, actionId: string, reason: string): void {
    const key = `${threadId}\u0000${actionId}\u0000${reason}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn("Run on settle skipped", { threadId, actionId, reason });
  }
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await NodeFSPromises.access(path);
    return true;
  } catch {
    return false;
  }
}
