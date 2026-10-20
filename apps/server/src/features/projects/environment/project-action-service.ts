import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { actionSchedule, terminalCapMessage } from "@mcode/contracts";
import type {
  WorkspaceEnvironmentActionRun,
  WorkspaceEnvironmentActionPort,
  WorkspaceEnvironmentActionLaunchSnapshot,
  WorkspaceEnvironmentActionSlotInput,
  WorkspaceEnvironmentActionStartInput,
} from "@mcode/contracts";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  TERMINAL_BACKEND_TOKEN,
  PreparedTerminalCommandApprovalMismatchError,
  PreparedTerminalCommandStartError,
  ActionTerminalClosedError,
  TerminalCapacityError,
  type ActionTerminal,
  type TerminalBackend,
} from "../../terminal/backends/terminal-backend.js";
import { ProjectActionAdmissionGate, type ProjectActionStartThread } from "./project-action-admission.js";
import { compensateFailedProjectActionLaunch } from "./project-action-launch-compensation.js";
import {
  resolveApprovalAfterLaunchMismatch,
  resolveProjectAction,
  type ProjectActionResolution,
} from "./project-action-resolution.js";
import { ProjectActionRunFactory } from "./project-action-run-factory.js";
import { ProjectActionRunLifecycle } from "./project-action-run-lifecycle.js";
import { ProjectActionRunPublisher, type ProjectActionRunUpdate } from "./project-action-run-publisher.js";
import {
  createStartingProjectAction,
  type ActiveProjectAction,
  type ProjectActionSlotState,
  type StartingProjectAction,
} from "./project-action-types.js";
import { WorkspaceEnvironmentService } from "./workspace-environment-service.js";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";
import { ProjectActionRunRepo } from "./persistence/project-action-run-repo.js";
import { ActionPortMonitor } from "./action-port-monitor.js";
import { candidateFromConfiguredUrl } from "./action-port-detector.js";

/** Clock used to timestamp Project Action lifecycle transitions. */
export type ProjectActionClock = () => Date;

/** Factory used to assign a new immutable identity to each Project Action run. */
export type ProjectActionRunIdFactory = () => string;

/** Dependency-injection token for the production Project Action clock. */
export const PROJECT_ACTION_CLOCK_TOKEN = "ProjectActionClock";

/** Dependency-injection token for the production Project Action run-ID factory. */
export const PROJECT_ACTION_RUN_ID_FACTORY_TOKEN = "ProjectActionRunIdFactory";

export type { ProjectActionRunUpdate };

type ProjectActionStartOptions = {
  trigger: WorkspaceEnvironmentActionRun["trigger"];
  expectedScriptHash?: string;
  skipUnapproved?: boolean;
};

/** Options for {@link ProjectActionService.launch}. */
export type ProjectActionLaunchOptions = ProjectActionStartOptions;

/** Whether a run has already announced its preview, so each run opens at most one tab. */
export interface ProjectActionPreviewRequest {
  readonly emitted: boolean;
}

/**
 * Decides whether a run should now ask clients to open its preview.
 *
 * Due exactly when the run asked for one, has not announced it yet, is still running and its port
 * monitor reports the URL reachable. The URL is the one that was probed, so what opens is what was
 * checked.
 */
export function previewDue(
  request: ProjectActionPreviewRequest | undefined,
  run: Pick<WorkspaceEnvironmentActionRun, "runId" | "status" | "port">,
): { readonly url: string } | null {
  if (!request || request.emitted || run.status !== "running") return null;
  if (!run.port?.reachable || run.port.runId !== run.runId) return null;
  return { url: run.port.url };
}

class UnapprovedLaunchSkipped extends Error {}

interface ProjectActionStartContext {
  readonly expectedRunId?: string;
  readonly slot: string;
  readonly thread: ProjectActionStartThread;
  readonly actionId: string;
  readonly reservation: StartingProjectAction;
  readonly trigger: WorkspaceEnvironmentActionRun["trigger"];
  readonly expectedScriptHash?: string;
  readonly skipUnapproved?: boolean;
}

/** Owns Project Action slot exclusion, latest-run retention, and backend process lifecycle. */
@injectable()
export class ProjectActionService {
  private readonly terminals = new Map<string, {
    threadId: string; terminal: ActionTerminal; unsubscribe: (() => void)[]; closed: Promise<void>;
  }>();
  private readonly outputListeners = new Set<(run: WorkspaceEnvironmentActionRun, bytes: Uint8Array) => void>();
  private readonly active = new Map<string, ProjectActionSlotState>();
  private readonly previews = new Map<string, { emitted: boolean }>();
  private readonly admission = new ProjectActionAdmissionGate();
  private readonly publisher: ProjectActionRunPublisher;
  private readonly runFactory: ProjectActionRunFactory;
  private readonly runLifecycle: ProjectActionRunLifecycle;
  private disposePromise: Promise<void> | null = null;

  constructor(
    @inject(ProjectActionRunRepo) private readonly runs: ProjectActionRunRepo,
    @inject(WorkspaceEnvironmentService) private readonly environment: WorkspaceEnvironmentService,
    @inject("ThreadRepo") private readonly threads: ThreadRepo,
    @inject(TERMINAL_BACKEND_TOKEN) private readonly terminal: TerminalBackend,
    @inject(PROJECT_ACTION_CLOCK_TOKEN)
    now: ProjectActionClock = () => new Date(),
    @inject(PROJECT_ACTION_RUN_ID_FACTORY_TOKEN)
    createRunId: ProjectActionRunIdFactory = NodeCrypto.randomUUID,
  ) {
    this.publisher = new ProjectActionRunPublisher(this.runs);
    this.runFactory = new ProjectActionRunFactory(now, createRunId, () => this.environment.platform());
    this.runLifecycle = new ProjectActionRunLifecycle(
      this.runs,
      this.active,
      this.publisher,
      () => this.runFactory.timestamp(),
    );
  }

  /** Subscribes to retained Action run changes produced by this server process. */
  onUpdate(listener: (update: ProjectActionRunUpdate) => void): () => void {
    return this.publisher.onUpdate(listener);
  }

  /** Observe command bytes only; synthesized command echoes and shell output are excluded. */
  onCommandOutput(listener: (run: WorkspaceEnvironmentActionRun, bytes: Uint8Array) => void): () => void {
    this.outputListeners.add(listener);
    return () => { this.outputListeners.delete(listener); };
  }

  /** Lists bounded retained Action results for one Thread. */
  list(threadId: string): WorkspaceEnvironmentActionRun[] {
    return this.runs.list(threadId);
  }

  /** Returns one retained Action result for a stable Thread and Action slot. */
  get(input: WorkspaceEnvironmentActionSlotInput): WorkspaceEnvironmentActionRun | null {
    return this.runs.get(input.threadId, input.actionId);
  }

  /**
   * Starts an Action or returns the run already owned by its open terminal.
   *
   * With `expectedRunId`, the start only continues the approval that run is waiting on. A closed
   * terminal fails with `WORKSPACE_ENVIRONMENT_RUN_CLOSED` instead of opening a new one.
   */
  async start(input: WorkspaceEnvironmentActionStartInput, options: ProjectActionStartOptions = { trigger: "manual" }): Promise<WorkspaceEnvironmentActionRun> {
    const thread = this.threads.findById(input.threadId);
    if (!thread) throw threadNotFoundError();
    this.admission.assertThreadCanStart(thread, thread);
    const slot = slotKey(input.threadId, input.actionId);
    const retained = this.runs.get(input.threadId, input.actionId);
    this.assertApprovalStillOpen(slot, retained, input.expectedRunId);
    if (this.terminals.has(slot) && retained?.status !== "awaiting-approval") {
      if (this.active.get(slot)?.state === "pending-finalization") throw actionAlreadyRunningError();
      if (retained) return retained;
    }
    return this.startNewRun(input, approvalStartOptions(retained, options));
  }

  /**
   * Starts a fresh run for an automatic trigger and never answers with an earlier run.
   *
   * A run that is still running, or whose terminal is open, is replaced; `start` would hand back
   * that retained result instead. With `skipUnapproved`, a run waiting for approval is left alone
   * and so is an action whose command is not approved yet, so an unattended launch can neither
   * create nor disturb approval work. That case returns `null`.
   */
  launch(input: WorkspaceEnvironmentActionSlotInput, options: ProjectActionLaunchOptions & { skipUnapproved: true }): Promise<WorkspaceEnvironmentActionRun | null>;
  launch(input: WorkspaceEnvironmentActionSlotInput, options: ProjectActionLaunchOptions): Promise<WorkspaceEnvironmentActionRun>;
  async launch(input: WorkspaceEnvironmentActionSlotInput, options: ProjectActionLaunchOptions): Promise<WorkspaceEnvironmentActionRun | null> {
    if (!options.skipUnapproved) return await this.restart(input, options);
    if (this.runs.get(input.threadId, input.actionId)?.status === "awaiting-approval") return null;
    if ((await resolveProjectAction(this.environment, input.threadId, input.actionId)).kind === "awaiting-approval") return null;
    try {
      return await this.restart(input, options);
    } catch (error) {
      if (error instanceof UnapprovedLaunchSkipped) return null;
      throw error;
    }
  }

  private assertApprovalStillOpen(
    slot: string,
    retained: WorkspaceEnvironmentActionRun | null,
    expectedRunId: string | undefined,
  ): void {
    if (expectedRunId === undefined) return;
    const open = retained?.runId === expectedRunId
      && retained.status === "awaiting-approval"
      && this.terminals.has(slot);
    if (!open) throw runClosedError();
  }

  private async startNewRun(input: WorkspaceEnvironmentActionStartInput, options: ProjectActionStartOptions): Promise<WorkspaceEnvironmentActionRun> {
    const context = { ...this.createStartContext(input), ...options };
    let releaseAdmission: (() => void) | null = null;
    try {
      releaseAdmission = this.admission.reserveStart(context.thread.id, context.thread.workspace_id);
      return await this.startAdmittedAction(context);
    } finally {
      this.releaseStartingReservation(context);
      releaseAdmission?.();
    }
  }

  /** Stops one running Action and waits for its backend close barrier. */
  async stop(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun | null> {
    const active = await this.activeForSlot(slotKey(input.threadId, input.actionId));
    if (!active) {
      await this.terminals.get(slotKey(input.threadId, input.actionId))?.terminal.stopCommand();
      const pending = this.runs.get(input.threadId, input.actionId);
      if (pending?.status === "awaiting-approval") {
        return this.publisher.persistAndPublish({
          ...pending, revision: pending.revision + 1, status: "interrupted", finishedAt: this.runFactory.timestamp(),
        });
      }
      return pending;
    }
    if (active.state === "pending-finalization") return this.retryFinalization(input, active);
    return await this.stopRunningAction(input, active);
  }

  /** Creates a fresh run after the previous command settles, reusing its terminal. */
  async restart(input: WorkspaceEnvironmentActionSlotInput, options: ProjectActionStartOptions = { trigger: "manual" }): Promise<WorkspaceEnvironmentActionRun> {
    const active = await this.activeForSlot(slotKey(input.threadId, input.actionId));
    if (active?.state === "pending-finalization") await this.retryFinalization(input, active);
    else if (active) await this.stopRunningAction(input, active, "replace");
    return await this.startNewRun(input, options);
  }

  /** Closes every Action terminal owned by one Thread and persists its final state. */
  async stopForThread(threadId: string): Promise<void> {
    const terminals = [...this.terminals.values()].filter((tracked) => tracked.threadId === threadId);
    await Promise.all(terminals.map(async (tracked) => {
      await this.terminal.kill(tracked.terminal.terminalSessionId);
      await tracked.closed;
    }));
  }

  /** Blocks new starts for one Thread and waits for starts already admitted to settle. */
  async beginThreadTeardown(threadId: string): Promise<() => void> {
    return await this.admission.beginThreadTeardown(threadId);
  }

  /** Blocks new starts for every Thread in a Workspace while deletion tears it down. */
  async beginWorkspaceTeardown(workspaceId: string): Promise<() => void> {
    return await this.admission.beginWorkspaceTeardown(workspaceId);
  }

  /** Restores Action admission after a completed Thread is reopened. */
  reopenThread(threadId: string): void {
    this.admission.reopenThread(threadId);
  }

  /** Stops all active Action sessions before the selected terminal backend shuts down. */
  dispose(): Promise<void> {
    if (!this.disposePromise) this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  /** Interrupts stale runs and clears terminal identities after startup recovery has reaped terminals. */
  async recoverStaleRuns(): Promise<WorkspaceEnvironmentActionRun[]> {
    const recovered: WorkspaceEnvironmentActionRun[] = [];
    while (true) {
      const runs = await this.runs.interruptRunning(this.runFactory.timestamp());
      for (const run of runs) this.publisher.publish(run);
      recovered.push(...runs);
      if (runs.length < 256) return recovered;
    }
  }

  private createStartContext(input: WorkspaceEnvironmentActionStartInput): Omit<ProjectActionStartContext, "trigger" | "expectedScriptHash" | "skipUnapproved"> {
    const slot = slotKey(input.threadId, input.actionId);
    if (this.active.has(slot)) throw actionAlreadyRunningError();
    const thread = this.threads.findById(input.threadId);
    if (!thread || thread.deleted_at) throw threadNotFoundError();
    this.admission.assertThreadCanStart(thread, this.threads.findById(thread.id));
    const reservation = createStartingProjectAction(thread.id, input.actionId);
    this.active.set(slot, reservation);
    return { slot, thread, actionId: input.actionId, reservation, expectedRunId: input.expectedRunId };
  }

  private async startAdmittedAction(context: ProjectActionStartContext): Promise<WorkspaceEnvironmentActionRun> {
    const resolved = await resolveProjectAction(this.environment, context.thread.id, context.actionId);
    if (context.expectedScriptHash && resolved.snapshot.script !== null
      && NodeCrypto.createHash("sha256").update(resolved.snapshot.script).digest("hex") !== context.expectedScriptHash) {
      const failed = this.runFactory.createFailed({
        ...this.runInput(context, resolved), script: resolved.snapshot.script,
      });
      return this.publisher.persistAndPublish({
        ...failed, terminalSessionId: this.terminals.get(context.slot)?.terminal.terminalSessionId ?? null,
      });
    }
    this.admission.assertThreadCanStart(context.thread, this.threads.findById(context.thread.id));
    return await this.startResolvedAction(context, resolved);
  }

  private async startResolvedAction(
    context: ProjectActionStartContext,
    resolved: ProjectActionResolution,
  ): Promise<WorkspaceEnvironmentActionRun> {
    if (resolved.kind === "launch") return await this.launchResolvedAction(context, resolved);
    if (resolved.kind === "unavailable") return this.publisher.persistAndPublish(this.runFactory.createUnavailable(this.runInput(context, resolved)));
    if (resolved.kind === "configuration") return this.publisher.persistAndPublish(this.runFactory.createFailed({ ...this.runInput(context, resolved), script: null }));
    // Approval can be revoked between the caller's check and this resolution.
    if (context.skipUnapproved) throw new UnapprovedLaunchSkipped();
    return this.retainPendingApproval(context, resolved);
  }

  private async launchResolvedAction(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { readonly kind: "launch" }>,
  ): Promise<WorkspaceEnvironmentActionRun> {
    let session: ActionTerminal | null = this.terminals.get(context.slot)?.terminal ?? null;
    this.assertTerminalStillOpen(context, session);
    let launched = false;
    try {
      const launch = { script: resolved.script, expectedLaunch: { terminal: resolved.snapshot.terminal } };
      let snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
      if (session) {
        this.clearRunListeners(context.slot);
        snapshot = await session.run(launch);
      } else {
        session = await this.terminal.openActionTerminal({
          threadId: context.thread.id, actionId: context.actionId, launch,
        });
        this.trackTerminal(context, session);
        snapshot = session.snapshot ?? resolved.snapshot;
      }
      launched = true;
      return await this.retainLaunchedAction(context, resolved, session, snapshot);
    } catch (error) {
      if (error instanceof TerminalCapacityError) throw terminalCapError(resolved.action.name);
      return await this.handleLaunchFailure(context, resolved, launched ? session : null, error);
    }
  }

  private async retainPendingApproval(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { kind: "awaiting-approval" }>,
  ): Promise<WorkspaceEnvironmentActionRun> {
    let terminal = this.terminals.get(context.slot)?.terminal;
    this.assertTerminalStillOpen(context, terminal ?? null);
    if (!terminal) {
      try {
        terminal = await this.terminal.openActionTerminal({
          threadId: context.thread.id, actionId: context.actionId,
          launch: "pending-approval",
        });
        this.trackTerminal(context, terminal);
      } catch (error) {
        if (error instanceof TerminalCapacityError) throw terminalCapError(resolved.action.name);
        throw error;
      }
    }
    const run = this.runFactory.createAwaitingApproval(this.runInput(context, resolved));
    return this.publisher.persistAndPublish({ ...run, terminalSessionId: terminal.terminalSessionId });
  }

  /** Environment resolution awaits, so the terminal an approval was bound to can close before the launch. */
  private assertTerminalStillOpen(context: ProjectActionStartContext, terminal: ActionTerminal | null): void {
    if (context.expectedRunId !== undefined && !terminal) throw runClosedError();
  }

  private trackTerminal(context: ProjectActionStartContext, terminal: ActionTerminal): void {
    const unsubscribe: (() => void)[] = [];
    const tracked = { threadId: context.thread.id, terminal, unsubscribe, closed: Promise.resolve() };
    this.terminals.set(context.slot, tracked);
    terminal.onClosed(() => {
      this.clearRunListeners(context.slot);
      this.terminals.delete(context.slot);
      tracked.closed = this.clearClosedTerminal(context, terminal.terminalSessionId);
      void tracked.closed.catch((error: unknown) => {
        logger.error("Closed action terminal persistence failed", { error: String(error) });
      });
    });
  }

  private clearRunListeners(slot: string): void {
    const tracked = this.terminals.get(slot);
    for (const unsubscribe of tracked?.unsubscribe ?? []) unsubscribe();
    if (tracked) tracked.unsubscribe = [];
  }

  private async clearClosedTerminal(context: ProjectActionStartContext, terminalSessionId: string): Promise<void> {
    const starting = this.active.get(context.slot);
    if (starting?.state === "starting") await starting.settled;
    const active = this.active.get(context.slot);
    if (active && active.state !== "starting") {
      active.stopping = true;
      this.previews.delete(active.run.runId);
      await this.runLifecycle.finish(context.slot, active.run.runId, 130);
      await this.runLifecycle.retryPendingFinalization(context.slot, active);
    }
    const run = this.runs.get(context.thread.id, context.actionId);
    if (!run || run.terminalSessionId !== terminalSessionId) return;
    const closed: WorkspaceEnvironmentActionRun = {
      ...run, revision: run.revision + 1, terminalSessionId: null,
      ...(run.status === "awaiting-approval" ? { status: "interrupted", finishedAt: this.runFactory.timestamp() } : {}),
    };
    if (await this.runs.updateIfCurrent(closed)) this.publisher.publish(closed);
  }

  private async retainLaunchedAction(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { readonly kind: "launch" }>,
    session: ActionTerminal,
    snapshot: WorkspaceEnvironmentActionLaunchSnapshot,
  ): Promise<WorkspaceEnvironmentActionRun> {
    const active: ActiveProjectAction = {
      state: "running",
      threadId: context.thread.id,
      actionId: resolved.action.id,
      session,
      run: this.runFactory.createActive({
        ...this.runInput(context, resolved),
        session,
        snapshot,
      }),
      pendingFinalization: null,
      stopping: false,
    };
    this.active.set(context.slot, active);
    await this.publisher.persistAndPublish(active.run);
    const runId = active.run.runId;
    const preview = actionSchedule(resolved.action).preview;
    if (preview) this.previews.set(runId, { emitted: false });
    const monitor = new ActionPortMonitor(runId, () => this.runFactory.timestamp(), (port) => {
      void this.publishPort(context.slot, active, port).catch((error: unknown) => {
        logger.error("Project Action port publication failed", { runId, error: String(error) });
      });
    });
    const configured = preview?.url ? candidateFromConfiguredUrl(preview.url) : null;
    if (configured) monitor.pin(configured);
    const unsubscribe = [() => monitor.stop()];
    const tracked = this.terminals.get(context.slot);
    if (tracked) tracked.unsubscribe = unsubscribe;
    unsubscribe.push(session.onCommandOutput((bytes) => {
      monitor.write(bytes);
      for (const listener of this.outputListeners) listener(active.run, bytes);
    }));
    unsubscribe.push(session.onCommandExit((exit) => this.finishAction(context.slot, runId, exit.exitCode)));
    if (active.state !== "running") for (const remove of unsubscribe) remove();
    this.settleStartingReservation(context);
    return active.run;
  }

  private async publishPort(slot: string, active: ActiveProjectAction, port: WorkspaceEnvironmentActionPort): Promise<void> {
    if (this.active.get(slot) !== active || active.state !== "running") return;
    const run = { ...active.run, revision: active.run.revision + 1, port };
    active.run = run;
    const persisted = await this.runs.updateIfCurrent(run);
    if (!persisted || active.run !== run || active.state !== "running") return;
    const request = this.previews.get(run.runId);
    const openPreview = previewDue(request, run);
    if (request && openPreview) request.emitted = true;
    this.publisher.publish(run, openPreview ?? undefined);
  }

  private async handleLaunchFailure(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { readonly kind: "launch" }>,
    session: ActionTerminal | null,
    error: unknown,
  ): Promise<WorkspaceEnvironmentActionRun> {
    const renewedApproval = await this.renewedApprovalAfterMismatch(context, error);
    if (renewedApproval) return this.retainPendingApproval(context, renewedApproval);
    if (session) return await this.compensateLaunchFailure(context, session, error);
    const failed = this.runFactory.createFailed({
      ...this.runInput(context, resolved),
      script: resolved.script,
      snapshot: error instanceof PreparedTerminalCommandStartError ? error.snapshot : resolved.snapshot,
    });
    return this.publisher.persistAndPublish({
      ...failed,
      ...(error instanceof ActionTerminalClosedError
        ? { status: "interrupted", terminalSessionId: null }
        : { terminalSessionId: this.terminals.get(context.slot)?.terminal.terminalSessionId ?? null }),
    });
  }

  private async renewedApprovalAfterMismatch(
    context: ProjectActionStartContext,
    error: unknown,
  ): Promise<Extract<ProjectActionResolution, { readonly kind: "awaiting-approval" }> | null> {
    if (!(error instanceof PreparedTerminalCommandApprovalMismatchError)) return null;
    return await resolveApprovalAfterLaunchMismatch(this.environment, context.thread.id, context.actionId);
  }

  private async compensateLaunchFailure(
    context: ProjectActionStartContext,
    session: ActionTerminal,
    error: unknown,
  ): Promise<never> {
    const active = this.active.get(context.slot);
    return await compensateFailedProjectActionLaunch({
      error,
      session,
      active: active?.state === "starting" ? null : active ?? null,
      onExit: (runId, exit) => this.finishAction(context.slot, runId, exit.exitCode),
      settleStart: () => this.settleStartingReservation(context),
    });
  }

  private runInput(
    context: ProjectActionStartContext,
    resolved: ProjectActionResolution,
  ): {
    readonly threadId: string;
    readonly workspaceId: string;
    readonly actionId: string;
    readonly actionName: string;
    readonly snapshot: ProjectActionResolution["snapshot"];
    readonly port: WorkspaceEnvironmentActionPort | null;
    readonly trigger: WorkspaceEnvironmentActionRun["trigger"];
  } {
    const previousPort = this.runs.get(context.thread.id, context.actionId)?.port;
    return {
      trigger: context.trigger,
      threadId: context.thread.id,
      workspaceId: context.thread.workspace_id,
      actionId: resolved.action.id,
      actionName: resolved.action.name,
      snapshot: resolved.snapshot,
      port: previousPort ? { ...previousPort, reachable: false } : null,
    };
  }

  private finishAction(slot: string, runId: string, exitCode: number | null): void {
    this.previews.delete(runId);
    const active = this.active.get(slot);
    if (active?.state === "running" && active.run.runId === runId) this.clearRunListeners(slot);
    void this.runLifecycle.finish(slot, runId, exitCode).catch((error: unknown) => {
      logger.error("Project Action completion publication failed", { runId, error: error instanceof Error ? error.message : String(error) });
    });
  }

  private releaseStartingReservation(context: ProjectActionStartContext): void {
    if (this.active.get(context.slot) !== context.reservation) return;
    this.active.delete(context.slot);
    context.reservation.resolve(null);
  }

  private settleStartingReservation(context: ProjectActionStartContext): void {
    const retained = this.active.get(context.slot);
    context.reservation.resolve(retained?.state === "running" ? retained : null);
  }

  private async activeForSlot(slot: string): Promise<ActiveProjectAction | null> {
    const state = this.active.get(slot);
    if (!state) return null;
    return state.state === "starting" ? await state.settled : state;
  }

  private async retryFinalization(
    input: WorkspaceEnvironmentActionSlotInput,
    active: ActiveProjectAction,
  ): Promise<WorkspaceEnvironmentActionRun | null> {
    await this.runLifecycle.retryPendingFinalization(slotKey(input.threadId, input.actionId), active);
    return this.runs.get(input.threadId, input.actionId);
  }

  private async stopRunningAction(
    input: WorkspaceEnvironmentActionSlotInput,
    active: ActiveProjectAction,
    afterExit: "shell" | "replace" = "shell",
  ): Promise<WorkspaceEnvironmentActionRun | null> {
    active.stopping = true;
    try {
      await active.session.stopCommand(afterExit);
    } finally {
      const current = this.active.get(slotKey(input.threadId, input.actionId));
      if (current?.state === "pending-finalization") await this.runLifecycle.retryPendingFinalization(slotKey(input.threadId, input.actionId), current);
    }
    return this.runs.get(input.threadId, input.actionId);
  }

  private async disposeOnce(): Promise<void> {
    this.admission.beginDisposal();
    const threadIds = new Set([...this.admission.threadIds(), ...this.activeThreadIds()]);
    const barriers = await Promise.all([...threadIds].map((threadId) => this.beginThreadTeardown(threadId)));
    try {
      await Promise.all([...threadIds].map((threadId) => this.stopForThread(threadId)));
    } finally {
      for (const release of barriers) release();
      this.admission.clear();
    }
  }

  private activeThreadIds(): string[] {
    return [...new Set([
      ...[...this.active.values()].map((active) => active.threadId),
      ...[...this.terminals.values()].map((tracked) => tracked.threadId),
    ])];
  }
}

function actionAlreadyRunningError(): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError(
    "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    "This Project Action is already running for this Thread",
  );
}

function runClosedError(): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError(
    "WORKSPACE_ENVIRONMENT_RUN_CLOSED",
    "The terminal waiting for approval was closed",
  );
}

function threadNotFoundError(): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError("WORKSPACE_ENVIRONMENT_NOT_FOUND", "Thread not found");
}

function slotKey(threadId: string, actionId: string): string {
  return `${threadId}\u0000${actionId}`;
}

function terminalCapError(actionName: string): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError(
    "WORKSPACE_ENVIRONMENT_TERMINAL_CAP",
    terminalCapMessage(actionName),
  );
}

function approvalStartOptions(retained: WorkspaceEnvironmentActionRun | null, options: ProjectActionStartOptions): ProjectActionStartOptions {
  if (retained?.status !== "awaiting-approval") return options;
  return {
    ...options, trigger: retained.trigger,
    expectedScriptHash: options.expectedScriptHash ?? (retained.trigger === "startup"
      ? NodeCrypto.createHash("sha256").update(retained.snapshot.script ?? "").digest("hex") : undefined),
  };
}
