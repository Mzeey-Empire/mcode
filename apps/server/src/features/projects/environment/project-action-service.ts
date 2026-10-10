import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type {
  WorkspaceEnvironmentActionRun,
  WorkspaceEnvironmentActionLaunchSnapshot,
  WorkspaceEnvironmentActionSlotInput,
} from "@mcode/contracts";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import {
  TERMINAL_BACKEND_TOKEN,
  PreparedTerminalCommandApprovalMismatchError,
  PreparedTerminalCommandStartError,
  type ActionTerminal,
  type TerminalBackend,
} from "../../terminal/backends/terminal-backend.js";
import { TerminalCapacityError } from "../../terminal/backends/legacy/terminal-service.js";
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

/** Clock used to timestamp Project Action lifecycle transitions. */
export type ProjectActionClock = () => Date;

/** Factory used to assign a new immutable identity to each Project Action run. */
export type ProjectActionRunIdFactory = () => string;

/** Dependency-injection token for the production Project Action clock. */
export const PROJECT_ACTION_CLOCK_TOKEN = "ProjectActionClock";

/** Dependency-injection token for the production Project Action run-ID factory. */
export const PROJECT_ACTION_RUN_ID_FACTORY_TOKEN = "ProjectActionRunIdFactory";

export type { ProjectActionRunUpdate };

interface ProjectActionStartContext {
  readonly slot: string;
  readonly thread: ProjectActionStartThread;
  readonly actionId: string;
  readonly reservation: StartingProjectAction;
}

/** Owns Project Action slot exclusion, latest-run retention, and backend process lifecycle. */
@injectable()
export class ProjectActionService {
  private readonly terminals = new Map<string, { terminal: ActionTerminal; unsubscribe: (() => void)[] }>();
  private readonly active = new Map<string, ProjectActionSlotState>();
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

  /** Lists bounded retained Action results for one Thread. */
  list(threadId: string): WorkspaceEnvironmentActionRun[] {
    return this.runs.list(threadId);
  }

  /** Returns one retained Action result for a stable Thread and Action slot. */
  get(input: WorkspaceEnvironmentActionSlotInput): WorkspaceEnvironmentActionRun | null {
    return this.runs.get(input.threadId, input.actionId);
  }

  /** Starts an Action or returns the run already owned by its open terminal. */
  async start(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun> {
    const thread = this.threads.findById(input.threadId);
    if (!thread) throw threadNotFoundError();
    this.admission.assertThreadCanStart(thread, thread);
    const slot = slotKey(input.threadId, input.actionId);
    const retained = this.runs.get(input.threadId, input.actionId);
    if (this.terminals.has(slot) && retained?.status !== "awaiting-approval") {
      if (this.active.get(slot)?.state === "pending-finalization") throw actionAlreadyRunningError();
      if (retained) return retained;
    }
    return this.startNewRun(input);
  }

  private async startNewRun(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun> {
    const context = this.createStartContext(input);
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
      return this.runs.get(input.threadId, input.actionId);
    }
    if (active.state === "pending-finalization") return this.retryFinalization(input, active);
    return await this.stopRunningAction(input, active);
  }

  /** Creates a fresh run after the previous command settles, reusing its terminal. */
  async restart(input: WorkspaceEnvironmentActionSlotInput): Promise<WorkspaceEnvironmentActionRun> {
    if (this.active.has(slotKey(input.threadId, input.actionId))) await this.stop(input);
    return await this.startNewRun(input);
  }

  /** Stops all active Action sessions owned by one Thread. */
  async stopForThread(threadId: string): Promise<void> {
    const actions = [...this.active.values()]
      .filter((active) => active.threadId === threadId)
      .map((active) => this.stop({ threadId, actionId: active.actionId }));
    await Promise.all(actions);
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

  /** Converts surviving persisted running rows to interrupted after startup recovery has reaped terminals. */
  async recoverStaleRuns(): Promise<WorkspaceEnvironmentActionRun[]> {
    const interrupted: WorkspaceEnvironmentActionRun[] = [];
    while (true) {
      const runs = await this.runs.interruptRunning(this.runFactory.timestamp());
      for (const run of runs) this.publisher.publish(run);
      interrupted.push(...runs);
      if (runs.length < 256) return interrupted;
    }
  }

  private createStartContext(input: WorkspaceEnvironmentActionSlotInput): ProjectActionStartContext {
    const slot = slotKey(input.threadId, input.actionId);
    if (this.active.has(slot)) throw actionAlreadyRunningError();
    const thread = this.threads.findById(input.threadId);
    if (!thread || thread.deleted_at) throw threadNotFoundError();
    this.admission.assertThreadCanStart(thread, this.threads.findById(thread.id));
    const reservation = createStartingProjectAction(thread.id, input.actionId);
    this.active.set(slot, reservation);
    return { slot, thread, actionId: input.actionId, reservation };
  }

  private async startAdmittedAction(context: ProjectActionStartContext): Promise<WorkspaceEnvironmentActionRun> {
    const resolved = await resolveProjectAction(this.environment, context.thread.id, context.actionId);
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
    return this.retainPendingApproval(context, resolved);
  }

  private async launchResolvedAction(
    context: ProjectActionStartContext,
    resolved: Extract<ProjectActionResolution, { readonly kind: "launch" }>,
  ): Promise<WorkspaceEnvironmentActionRun> {
    let session: ActionTerminal | null = this.terminals.get(context.slot)?.terminal ?? null;
    let launched = false;
    try {
      const launch = { script: resolved.script, expectedLaunch: { terminal: resolved.snapshot.terminal } };
      let snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
      if (session) {
        this.clearRunListeners(context.slot);
        snapshot = await session.run(launch);
      } else {
        session = await this.terminal.openActionTerminal({
          threadId: context.thread.id, actionId: context.actionId, echo: resolved.script, launch,
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
    if (!terminal) {
      try {
        terminal = await this.terminal.openActionTerminal({
          threadId: context.thread.id, actionId: context.actionId,
          echo: resolved.snapshot.script ?? "", launch: "pending-approval",
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

  private trackTerminal(context: ProjectActionStartContext, terminal: ActionTerminal): void {
    this.terminals.set(context.slot, { terminal, unsubscribe: [] });
    terminal.onClosed(() => {
      this.clearRunListeners(context.slot);
      this.terminals.delete(context.slot);
      void this.clearClosedTerminal(context, terminal.terminalSessionId).catch((error: unknown) => {
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
      await this.runLifecycle.finish(context.slot, active.run.runId, 130);
      await this.runLifecycle.retryPendingFinalization(context.slot, active);
    }
    const run = this.runs.get(context.thread.id, context.actionId);
    if (!run || run.terminalSessionId !== terminalSessionId) return;
    const closed = { ...run, revision: run.revision + 1, terminalSessionId: null };
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
      outputRemainder: new Uint8Array(),
      stopping: false,
    };
    this.active.set(context.slot, active);
    await this.publisher.persistAndPublish(active.run);
    const runId = active.run.runId;
    const unsubscribe = [
      session.onCommandOutput((data) => this.runLifecycle.recordOutput(context.slot, runId, data)),
      session.onCommandExit((exit) => this.finishAction(context.slot, runId, exit.exitCode)),
    ];
    const tracked = this.terminals.get(context.slot);
    if (tracked) tracked.unsubscribe = unsubscribe;
    this.settleStartingReservation(context);
    return active.run;
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
      ...failed, terminalSessionId: this.terminals.get(context.slot)?.terminal.terminalSessionId ?? null,
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
  } {
    return {
      threadId: context.thread.id,
      workspaceId: context.thread.workspace_id,
      actionId: resolved.action.id,
      actionName: resolved.action.name,
      snapshot: resolved.snapshot,
    };
  }

  private finishAction(slot: string, runId: string, exitCode: number | null): void {
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
  ): Promise<WorkspaceEnvironmentActionRun | null> {
    active.stopping = true;
    try {
      await active.session.stopCommand();
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
    return [...new Set([...this.active.values()].map((active) => active.threadId))];
  }
}

function actionAlreadyRunningError(): WorkspaceEnvironmentServiceError {
  return new WorkspaceEnvironmentServiceError(
    "WORKSPACE_ENVIRONMENT_ACTION_RUNNING",
    "This Project Action is already running for this Thread",
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
    `8 terminals are open. Close one to run ${actionName}.`,
  );
}
