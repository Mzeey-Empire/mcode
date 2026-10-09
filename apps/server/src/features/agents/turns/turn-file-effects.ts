import { logger } from "@mcode/shared";
import type { AgentEvent, ProviderFileMutationStart } from "@mcode/contracts";

import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import type { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import type { BaselinePin, SnapshotRefPins } from "../../projects/diffs/snapshots/snapshot-ref-pins.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import type { TurnFinalizer } from "./turn-finalizer.js";
import type { TurnFileTracker } from "./turn-file-tracker.js";
import type { TurnOutcome } from "./turn-outcome.js";

/** Injection token for the composed file-effect coordinator. */
export const TURN_FILE_EFFECTS = "TurnFileEffects";

/** Owns file-effect setup, observation ordering, and terminal prerequisites for one turn. */
export class TurnFileEffects {
  private readonly setupByThread = new Map<string, Promise<void>>();
  private readonly activityByThread = new Map<string, Promise<void>>();
  private readonly refCaptureByThread = new Map<string, Promise<void>>();
  private readonly finalizationByThread = new Map<string, Promise<boolean>>();

  constructor(
    private readonly threadRepo: ThreadRepo,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly gitWorktrees: GitWorktreeService,
    private readonly snapshots: SnapshotService,
    private readonly tracker: TurnFileTracker,
    private readonly finalizer: TurnFinalizer,
    private readonly pins?: Pick<SnapshotRefPins, "captureBaseline">,
  ) {}

  /**
   * Initialize tracking for the active turn without waiting for the ref capture. An admitted
   * execution names the baseline pin; a provider-originated generation pins by tree.
   */
  ensure(threadId: string, cwdOverride?: string, executionId?: string): Promise<void> {
    const existing = this.setupByThread.get(threadId);
    if (existing) return existing;
    const cwd = this.resolveWorkingDirectory(threadId, cwdOverride);
    if (!cwd) return Promise.resolve();
    const generation = this.begin(threadId, cwd);
    if (generation === undefined) return Promise.resolve();
    const setup = Promise.resolve();
    this.setupByThread.set(threadId, setup);
    this.activityByThread.set(threadId, setup);
    this.captureBaseline(threadId, cwd, generation, executionId);
    return setup;
  }

  /** Wait until the active generation has captured its baseline ref. */
  async waitForBaseline(threadId: string): Promise<void> {
    await this.refCaptureByThread.get(threadId);
  }

  /** Return the active baseline capture without exposing file-effect storage to callers. */
  get(threadId: string): Promise<void> | undefined {
    return this.refCaptureByThread.get(threadId);
  }

  /** Start tracking a new provider-resumed generation after the prior turn has persisted. */
  beginResumed(threadId: string): void {
    this.clearActiveGeneration(threadId);
    void this.ensure(threadId);
  }

  /** Record a private file mutation before its public tool event arrives. */
  observeProviderMutation(event: ProviderFileMutationStart): void {
    void this.ensure(event.threadId);
    this.queue(event.threadId, () => this.tracker.observeToolUse(
      event.threadId,
      event.toolCallId,
      event.toolName,
      event.toolInput,
    ));
  }

  /** Attribute a public tool start to the current file-effect generation. */
  observeToolUse(event: Extract<AgentEvent, { type: "toolUse" }>): void {
    this.queue(event.threadId, () => this.tracker.observeToolUse(
      event.threadId,
      event.toolCallId,
      event.toolName,
      event.toolInput,
    ));
  }

  /** Attribute a public tool completion to the current file-effect generation. */
  observeToolResult(event: Extract<AgentEvent, { type: "toolResult" }>): void {
    this.queue(event.threadId, () => this.tracker.observeToolResult(
      event.threadId,
      event.toolCallId,
      event.toolInput,
    ));
  }

  /** Return the preceding generation's finalizer so a resumed turn cannot overtake it. */
  previousFinalization(threadId: string): Promise<boolean> | undefined {
    return this.finalizationByThread.get(threadId);
  }

  /** Finalize after all tracked file effects and baseline capture complete. */
  finalize(
    threadId: string,
    outcome: TurnOutcome,
    executionId: string | undefined,
    source: string,
    persistence: Promise<unknown> = Promise.resolve(),
  ): Promise<boolean> {
    const existing = this.finalizationByThread.get(threadId);
    if (existing) return existing;
    const setup = this.setupByThread.get(threadId);
    const activity = this.activityByThread.get(threadId) ?? setup;
    const refCapture = this.refCaptureByThread.get(threadId);
    const prerequisite = Promise.all([persistence, activity ?? Promise.resolve(), refCapture ?? Promise.resolve()]);
    const finalization = Promise.allSettled([
      prerequisite, this.finalizer.finalize(threadId, outcome, prerequisite, executionId),
    ]).then((results) => this.settledFinalization(threadId, outcome, source, results));
    this.finalizationByThread.set(threadId, finalization);
    void finalization.finally(() => this.clearFinishedGeneration(threadId, setup, activity, refCapture, finalization));
    return finalization;
  }

  private settledFinalization(threadId: string, outcome: TurnOutcome, source: string,
    results: readonly PromiseSettledResult<unknown>[]): boolean {
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status !== "rejected") return true;
    const error: unknown = failed.reason;
    logger.error("finalize failed on terminal event", {
      threadId, outcome, source, error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  /** Return the active file-effect turn identity for renderer attribution. */
  currentTurnId(threadId: string): string | undefined {
    return this.tracker.getCurrentTurnId(threadId);
  }

  private resolveWorkingDirectory(threadId: string, cwdOverride?: string): string | undefined {
    const thread = this.threadRepo.findById(threadId);
    if (!thread) return undefined;
    const workspace = this.workspaceRepo.findById(thread.workspace_id);
    if (!workspace) return undefined;
    return cwdOverride ?? this.gitWorktrees.resolveWorkingDir(workspace.path, thread.mode, thread.worktree_path);
  }

  private begin(threadId: string, cwd: string): number | undefined {
    try {
      const generation = this.tracker.beginTurn(threadId, cwd, null);
      this.finalizer.recordTurnRef(threadId, null, cwd, generation);
      return generation;
    } catch (error) {
      logger.warn("Failed to initialize file tracker", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private captureBaseline(threadId: string, cwd: string, generation: number, executionId: string | undefined): void {
    const capture = this.captureBaselineRef(threadId, cwd, executionId).then(
      async ({ tree: refBefore, pin }) => {
        this.finalizer.recordTurnRef(threadId, refBefore, cwd, generation, pin);
        await this.tracker.setBaselineRef(threadId, generation, refBefore);
      },
      (error) => {
        logger.warn("Failed to capture ref_before", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    this.refCaptureByThread.set(threadId, capture);
  }

  private async captureBaselineRef(
    threadId: string,
    cwd: string,
    executionId: string | undefined,
  ): Promise<{ tree: string; pin?: BaselinePin }> {
    if (this.pins) return this.pins.captureBaseline(cwd, threadId, executionId);
    return { tree: await this.snapshots.captureRef(cwd) };
  }

  private queue(threadId: string, action: () => Promise<void>): void {
    const setup = this.setupByThread.get(threadId);
    if (!setup) return;
    const previous = this.activityByThread.get(threadId) ?? setup;
    const observation = new Promise<void>((resolve) => resolve(action())).catch((error) => {
      logger.warn("Failed to observe provider file event", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.activityByThread.set(threadId, Promise.all([previous, observation]).then(() => undefined));
  }

  private clearActiveGeneration(threadId: string): void {
    this.setupByThread.delete(threadId);
    this.activityByThread.delete(threadId);
    this.refCaptureByThread.delete(threadId);
  }

  private clearFinishedGeneration(
    threadId: string,
    setup: Promise<void> | undefined,
    activity: Promise<void> | undefined,
    refCapture: Promise<void> | undefined,
    finalization: Promise<boolean>,
  ): void {
    if (this.setupByThread.get(threadId) === setup) this.setupByThread.delete(threadId);
    if (this.activityByThread.get(threadId) === activity) this.activityByThread.delete(threadId);
    if (this.refCaptureByThread.get(threadId) === refCapture) this.refCaptureByThread.delete(threadId);
    if (this.finalizationByThread.get(threadId) === finalization) this.finalizationByThread.delete(threadId);
  }
}
