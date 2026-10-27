import { StartupActionRunner, type StartupProjectActions } from "./startup-action-runner.js";
import { upgradeEnvironmentDocument } from "./workspace-environment-upgrade.js";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { actionSchedule, DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT, encodeEnvironmentDocument, WORKSPACE_ENVIRONMENT_APPROVAL_CONTRACT_VERSION, WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES, WorkspaceEnvironmentDocumentSchema, workspaceEnvironmentValidationIssues, type WorkspaceEnvironmentPlatform, type WorkspaceEnvironmentStorageMode, type WorkspaceEnvironmentCommandTarget, type WorkspaceEnvironmentCommandApproval, type WorkspaceEnvironmentCommandApproveInput, type WorkspaceEnvironmentStorageSetInput, type WorkspaceEnvironmentCommand, type WorkspaceEnvironmentReadResult, type WorkspaceEnvironmentSaveInput, type WorkspaceEnvironmentActionLaunchSnapshot, type WorkspaceEnvironmentAction, type WorkspaceEnvironmentAutomaticSetupSnapshot, type WorkspaceEnvironmentAutomaticSetupStopInput, type WorkspaceEnvironmentAutomaticSetupRetryInput, type WorkspaceEnvironmentValidationIssue, type WorkspaceEnvironmentValidationReason } from "@mcode/contracts/models/workspace-environment";
import { type StoredAttachment } from "@mcode/contracts/models/attachment";
import { type ThreadStartup } from "@mcode/contracts/thread-startup";
import { type TurnRuntimePhase } from "@mcode/contracts/models/turn-runtime";
import { type MessageMention } from "@mcode/contracts/models/mention";
import { type PreviewAnnotationBundle } from "@mcode/contracts/models/browser-preview";
import { getMcodeDir, logger } from "@mcode/shared";
import { ZodError } from "zod";
import type { Database } from "bun:sqlite";
import type { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import { normalizeWorktreePath } from "../git/worktree-path.js";
import type {
  TerminalCommandPreparation,
  PreparedTerminalCommand,
} from "../../terminal/commands/terminal-command-service.js";
import { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";
import { WorkspaceEnvironmentConfigurationRepo } from "./persistence/workspace-environment-configuration-repo.js";
import {
  WorkspaceEnvironmentAutomaticRepository,
  WorkspaceEnvironmentAutomaticQueueCapacityError,
  type WorkspaceEnvironmentQueuedTurnSubmission,
  type WorkspaceEnvironmentQueueAdmission,
} from "./workspace-environment-automatic-repository.js";

export { WorkspaceEnvironmentServiceError } from "./workspace-environment-errors.js";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
/** Thread fields used by Setup eligibility and checkout occupancy. */
export interface WorkspaceEnvironmentSetupThread {
  readonly id: string;
  readonly workspace_id: string;
  readonly mode: string;
  readonly worktree_managed?: boolean;
  readonly worktree_path?: string | null;
  readonly deleted_at?: string | null;
  readonly cleanup_state?: string | null;
}

/** Setup eligibility follows the checkout; removal ownership is independent. */
export function isAutomaticSetupThread(thread: WorkspaceEnvironmentSetupThread): thread is WorkspaceEnvironmentSetupThread & { worktree_path: string } {
  return thread.mode === "worktree" && thread.worktree_path != null;
}

/** Workspace fields used to resolve the base checkout for shared Project configuration. */
export interface WorkspaceEnvironmentWorkspace {
  readonly id: string;
  readonly path: string;
}

/** Terminal command boundary consumed by the Project Setup lifecycle. */
export interface WorkspaceEnvironmentTerminalCommandExecutor {
  prepare(input: {
    readonly scope: { readonly kind: "thread"; readonly workspaceId: string; readonly threadId: string };
    readonly script: string;
    readonly timeoutMs: number;
    readonly outputMaxBytes: number;
    readonly onOutput?: (chunk: Uint8Array) => void;
  }): Promise<TerminalCommandPreparation>;
}

/** Attachment storage boundary for automatic queued Turn cleanup. */
export interface WorkspaceEnvironmentAttachmentStorage {
  removeStoredAttachments(threadId: string, attachments: readonly StoredAttachment[]): Promise<void>;
}

/** Accepted automatic Turn dispatch whose completion releases the Thread's provider slot. */
export interface WorkspaceEnvironmentAutomaticSetupDispatch {
  readonly completion: Promise<void>;
}

/** Post-commit boundary that resolves once a claimed queued Turn has started a runtime. */
export interface WorkspaceEnvironmentAutomaticSetupDispatcher {
  dispatch(submission: WorkspaceEnvironmentQueuedTurnSubmission): Promise<WorkspaceEnvironmentAutomaticSetupDispatch>;
}

/** Dependencies for startup actions and command resolution to environment persistence. */
export interface WorkspaceEnvironmentServiceOptions {
  readonly mcodeDir?: string;
  readonly threads?: {
    findById(id: string): WorkspaceEnvironmentSetupThread | null;
    listAllByWorkspace?(workspaceId: string): readonly WorkspaceEnvironmentSetupThread[];
  };
  readonly runtimePhase?: (threadId: string) => TurnRuntimePhase | undefined;
  readonly workspaces?: {
    findById(id: string): WorkspaceEnvironmentWorkspace | null;
  };
  readonly terminalCommands?: WorkspaceEnvironmentTerminalCommandExecutor;
  readonly projectActions?: () => StartupProjectActions;
  readonly attachmentStorage?: WorkspaceEnvironmentAttachmentStorage;
  readonly threadStartups?: Pick<
    ThreadStartupService,
    "appendOutputs" | "publish" | "block" | "complete" | "fail" | "findByThreadId" | "listInterrupted" | "markCancelled" | "resume" | "retryAgent" | "skip"
  >;
  readonly platform?: WorkspaceEnvironmentPlatform;
  readonly now?: () => Date;
  readonly database?: Database;
  readonly databaseWriter?: ApplicationDatabaseWriter;
}

function environmentRepositories(options: WorkspaceEnvironmentServiceOptions, now: () => string): {
  automatic: WorkspaceEnvironmentAutomaticRepository | null;
  configuration: WorkspaceEnvironmentConfigurationRepo | null;
} {
  if (!options.database) return { automatic: null, configuration: null };
  if (!options.databaseWriter) throw new Error("Project environment persistence requires its database writer");
  return {
    automatic: new WorkspaceEnvironmentAutomaticRepository(options.database, now, options.databaseWriter),
    configuration: new WorkspaceEnvironmentConfigurationRepo(options.database, options.databaseWriter),
  };
}

/** Resolved command facts shared by Setup approval and Project Action orchestration. */
export type WorkspaceEnvironmentCommandResolution =
  | {
    readonly kind: "ready";
    readonly command: PreparedTerminalCommand;
    readonly script: string;
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
    readonly approval: WorkspaceEnvironmentCommandApproval | null;
    readonly action: WorkspaceEnvironmentAction | null;
  }
  | {
    readonly kind: "unavailable";
    readonly output: string;
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
    readonly action: WorkspaceEnvironmentAction | null;
  }
  | {
    readonly kind: "configuration";
    readonly output: string;
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
    readonly action: WorkspaceEnvironmentAction | null;
  };

/** One Action's resolved command, carrying the Action it came from so callers can log by id. */
export type WorkspaceEnvironmentActionCommandResolution = WorkspaceEnvironmentCommandResolution & {
  readonly action: WorkspaceEnvironmentAction;
};

/** Time and output limits for one prepared Project command. */
export interface WorkspaceEnvironmentCommandBounds {
  readonly timeoutMs: number;
  readonly outputMaxBytes: number;
}

function unavailableCommandResolution(
  platform: WorkspaceEnvironmentPlatform,
  action: WorkspaceEnvironmentAction | null,
): WorkspaceEnvironmentCommandResolution {
  return {
    kind: "unavailable",
    output: "This Project command is not available on this system",
    snapshot: unavailableSnapshot(platform, null),
    action,
  };
}

function queuedAutomaticAttemptId(snapshot: WorkspaceEnvironmentAutomaticSetupSnapshot): string | null {
  return snapshot.attempt?.state === "queued" ? snapshot.attempt.id : null;
}

function issue(
  path: (string | number)[],
  code: string,
  reason: WorkspaceEnvironmentValidationReason,
  message: string,
): WorkspaceEnvironmentValidationIssue {
  return { path, code, reason, message };
}

function revisionFor(
  bytes: Uint8Array,
  storageMode: WorkspaceEnvironmentStorageMode,
  filePath: string,
): string {
  return NodeCrypto.createHash("sha256")
    .update(storageMode)
    .update("\0")
    .update(filePath)
    .update("\0")
    .update(bytes)
    .digest("hex");
}

function validationError(error: ZodError): WorkspaceEnvironmentServiceError {
  const issues = workspaceEnvironmentValidationIssues(error);
  const unsupported = issues.some((candidate) => candidate.reason === "unsupported_version");
  return new WorkspaceEnvironmentServiceError(
    unsupported
      ? "WORKSPACE_ENVIRONMENT_UNSUPPORTED_VERSION"
      : "WORKSPACE_ENVIRONMENT_VALIDATION",
    unsupported ? "Workspace environment version is not supported" : "Workspace environment failed validation",
    issues,
  );
}

/** Persists one private, system-local environment document per workspace. */
export class WorkspaceEnvironmentService {
  private readonly mcodeDir: string;
  private readonly saveTails = new Map<string, Promise<void>>();
  private readonly deletingThreadCounts = new Map<string, number>();
  private readonly deletingWorkspaceCounts = new Map<string, number>();
  private readonly options: WorkspaceEnvironmentServiceOptions;
  private readonly configuration: WorkspaceEnvironmentConfigurationRepo | null;
  private readonly inMemoryStorageModes = new Map<string, WorkspaceEnvironmentStorageMode>();
  private readonly inMemoryApprovals = new Map<string, string>();
  private readonly automaticRepository: WorkspaceEnvironmentAutomaticRepository | null;
  private readonly startupRunners = new Map<string, StartupActionRunner>();
  private readonly startingAutomaticSetupPromises = new Map<string, Promise<void>>();
  private readonly automaticWorktreeTails = new Map<string, Promise<void>>();
  private readonly automaticStopPromises = new Map<string, Promise<void>>();
  private readonly automaticRecoveryOperationTails = new Map<string, Promise<void>>();
  private readonly automaticStopGenerations = new Map<string, number>();
  private readonly automaticDrainLoops = new Map<string, Promise<void>>();
  private automaticDispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: string | WorkspaceEnvironmentServiceOptions = getMcodeDir()) {
    this.options = typeof options === "string" ? {} : options;
    this.mcodeDir = typeof options === "string" ? options : options.mcodeDir ?? getMcodeDir();
    const repositories = environmentRepositories(this.options, () => this.now());
    this.automaticRepository = repositories.automatic;
    this.configuration = repositories.configuration;
  }

  /** Returns the explicitly composed host platform for Project command resolution. */
  platform(): WorkspaceEnvironmentPlatform {
    return requireWorkspaceEnvironmentPlatform(this.options.platform);
  }

  /** Connect the one post-commit automatic Setup dispatcher during server composition. */
  setAutomaticSetupDispatcher(dispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher): void {
    this.automaticDispatcher = dispatcher;
  }

  /** Queue one Turn for a worktree thread and launch Setup after persistence commits. */
  async queueAutomaticFirstTurn(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly content: string;
    readonly attachments: readonly StoredAttachment[];
    readonly mentions: readonly MessageMention[];
    readonly previewAnnotations?: PreviewAnnotationBundle;
    readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
  }): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    return (await this.admitAutomaticTurn(input)).snapshot;
  }

  /** Admit one automatic Turn and report whether a concurrent release requires normal dispatch. */
  async admitAutomaticTurn(input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly content: string;
    readonly attachments: readonly StoredAttachment[];
    readonly mentions: readonly MessageMention[];
    readonly previewAnnotations?: PreviewAnnotationBundle;
    readonly submission: WorkspaceEnvironmentQueuedTurnSubmission;
  }): Promise<WorkspaceEnvironmentQueueAdmission> {
    const thread = this.requireAutomaticSetupThread(input.threadId);
    const repository = this.requireAutomaticRepository();
    let admission: WorkspaceEnvironmentQueueAdmission;
    try {
      admission = await repository.queueFirstTurn(input);
    } catch (error) {
      if (error instanceof WorkspaceEnvironmentAutomaticQueueCapacityError || error instanceof Error && error.name === "WorkspaceEnvironmentAutomaticQueueCapacityError") {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_SETUP_CAPACITY",
          "Automatic Setup queue capacity reached for this Thread",
        );
      }
      throw error;
    }
    if (admission.queued && admission.snapshot.attempt?.state === "queued") {
      if (this.isAutomaticSetupCancelled(thread.id)) {
        await repository.interruptCurrentAttempt(thread.id);
        await repository.cancelStartupTurns(thread.id);
        return { ...admission, snapshot: repository.snapshot(thread.id) };
      }
      if (input.submission.planImplement) await this.startAutomaticSetup(thread);
      else this.launchAutomaticSetup(thread);
    }
    return admission;
  }

  /** Return the reconnect-authoritative automatic Setup lifecycle for one Thread. */
  getAutomaticSetup(input: { readonly threadId: string }): WorkspaceEnvironmentAutomaticSetupSnapshot {
    return this.requireAutomaticRepository().snapshot(input.threadId);
  }

  /** Release queued Turns without rerunning Setup, then claim them for post-commit dispatch. */
  async continueAutomaticSetup(input: { readonly threadId: string }): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    this.requireAutomaticSetupThread(input.threadId);
    const repository = this.requireAutomaticRepository();
    const current = repository.snapshot(input.threadId);
    const state = current.attempt?.state;
    if (state !== "failed" && state !== "interrupted" && state !== "awaiting-approval" && state !== "running") {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Automatic Setup can continue only while running, blocked, or interrupted",
      );
    }
    await this.startupRunners.get(input.threadId)?.skip();
    this.startupRunners.delete(input.threadId);
    if (state === "awaiting-approval" || state === "running") await repository.interruptCurrentAttempt(input.threadId);
    if (!await repository.continueWithoutSetup(input.threadId)) {
      await this.settleStartupAfterDrain(input.threadId);
      return repository.snapshot(input.threadId);
    }
    await this.skipStartupSetup(input.threadId, "user-skipped");
    await this.drainReleasedAutomaticTurn(input.threadId);
    await this.settleStartupAfterDrain(input.threadId);
    this.requireAutomaticSetupThread(input.threadId);
    return repository.snapshot(input.threadId);
  }

  /** Contain automatic Setup, then discard pending Turns when startup cancellation was requested. */
  async stopAutomaticSetup(input: WorkspaceEnvironmentAutomaticSetupStopInput): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    this.requireAutomaticSetupThread(input.threadId);
    this.invalidateAutomaticRetry(input.threadId);
    const stopping = this.automaticStopPromises.get(input.threadId);
    if (stopping) return this.snapshotAfterAutomaticStop(input.threadId, stopping);
    const operation = this.interruptAutomaticSetupResources(input.threadId);
    this.automaticStopPromises.set(input.threadId, operation);
    let contained = false;
    try {
      await operation;
      contained = true;
    } finally {
      if (contained && this.automaticStopPromises.get(input.threadId) === operation) {
        this.automaticStopPromises.delete(input.threadId);
        this.clearAutomaticRecoveryGeneration(input.threadId);
      }
    }
    return this.requireAutomaticRepository().snapshot(input.threadId);
  }

  private async snapshotAfterAutomaticStop(threadId: string, stopping: Promise<void>): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    await stopping;
    return this.requireAutomaticRepository().snapshot(threadId);
  }

  private async interruptAutomaticSetupResources(threadId: string): Promise<void> {
    await this.requireAutomaticRepository().interruptCurrentAttempt(threadId);
    await Promise.all([
      this.startingAutomaticSetupPromises.get(threadId),
      this.startupRunners.get(threadId)?.cancel(),
    ]);
    this.startupRunners.delete(threadId);
    if (this.isAutomaticSetupCancelled(threadId)) await this.requireAutomaticRepository().cancelStartupTurns(threadId);
  }

  /** Re-resolve the current Project environment and start one new automatic Setup attempt. */
  async retryAutomaticSetup(input: WorkspaceEnvironmentAutomaticSetupRetryInput): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot> {
    const stopGeneration = this.automaticStopGenerations.get(input.threadId) ?? 0;
    return await this.runAutomaticRecoveryOperation(input.threadId, async () => {
      this.requireAutomaticSetupThread(input.threadId);
      const stopping = this.automaticStopPromises.get(input.threadId);
      if (stopping) await stopping;
      this.requireAutomaticSetupThread(input.threadId);
      if ((this.automaticStopGenerations.get(input.threadId) ?? 0) !== stopGeneration) {
        return this.requireAutomaticRepository().snapshot(input.threadId);
      }
      const thread = this.requireAutomaticSetupThread(input.threadId);
      await this.startupRunners.get(input.threadId)?.cancel();
      this.startupRunners.delete(input.threadId);
      if (await this.requireAutomaticRepository().retryCurrentAttempt(input.threadId)) {
        await this.startAutomaticSetup(thread);
        this.requireAutomaticSetupThread(input.threadId);
      }
      return this.requireAutomaticRepository().snapshot(input.threadId);
    });
  }

  /**
   * Send a startup's saved first message again after its agent failed before the runtime took it.
   * Setup does not run again: its gate is already released, and the claim keeps the persisted message.
   */
  async retryAutomaticAgentStart(input: { readonly threadId: string }): Promise<void> {
    await this.runAutomaticRecoveryOperation(input.threadId, async () => {
      this.requireAutomaticSetupThread(input.threadId);
      const repository = this.requireAutomaticRepository();
      const startups = this.options.threadStartups;
      const startup = startups?.findByThreadId(input.threadId);
      const unsent = repository.snapshot(input.threadId).queuedTurns.some((turn) => turn.state === "dispatching");
      if (!startups || startup?.state !== "failed" || startup.phase !== "agent" || !startup.error || !unsent) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
          "This thread has no unsent first message to retry",
        );
      }
      // The startup must be running before the claim is released: a released claim under a terminal startup drains as an ordinary send.
      if ((await startups.retryAgent(startup.startupId)).state !== "running") return;
      if (!await repository.releaseUnsentClaim(input.threadId)) {
        await startups.fail(startup.startupId, startup.error);
        return;
      }
      await this.drainReleasedAutomaticTurn(input.threadId);
    });
  }

  /** Mark interrupted automatic attempts at startup and drain only committed release claims. */
  async reconcileAutomaticSetup(): Promise<void> {
    const repository = this.requireAutomaticRepository();
    await repository.interruptUnfinishedAttempts();
    await this.drainReleasedAutomaticTurn();
    await this.settleInterruptedStartups(repository);
  }

  /** Resolve the exact private environment document path for one workspace. */
  filePath(workspaceId: string): string {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace id is not a safe path segment",
        [issue(["workspaceId"], "INVALID_WORKSPACE_ID", "invalid_value", "Workspace id is not a safe path segment")],
      );
    }
    return NodePath.join(this.mcodeDir, "projects", workspaceId, "environment.json");
  }

  /** Select the exclusive storage location and return its current document. */
  async setStorageMode(input: WorkspaceEnvironmentStorageSetInput): Promise<WorkspaceEnvironmentReadResult> {
    return this.enqueueSave(input.workspaceId, async () => {
      const thread = input.threadId ? this.requireSetupThread(input.threadId) : null;
      if (thread) {
        if (thread.workspace_id !== input.workspaceId) {
          throw new WorkspaceEnvironmentServiceError(
            "WORKSPACE_ENVIRONMENT_NOT_FOUND",
            "Thread does not belong to this Project",
          );
        }
      }
      if (input.storageMode === "shared") this.requireWorkspace(input.workspaceId);
      const filePath = thread
        ? this.filePathForThread(thread, input.storageMode)
        : this.filePathForWorkspace(input.workspaceId, input.storageMode);
      const result = await this.readAt(filePath, input.storageMode, input.workspaceId);
      await this.persistStorageMode(input.workspaceId, input.storageMode);
      return result;
    });
  }

  /** Removes all command approvals when a Project is deleted. */
  async removeWorkspaceApprovals(workspaceId: string): Promise<void> {
    await this.configuration?.removeWorkspaceApprovals(workspaceId);
    for (const key of this.inMemoryApprovals.keys()) {
      if (key.startsWith(`${workspaceId}:`)) this.inMemoryApprovals.delete(key);
    }
  }

  /** Forgets only one action's approval, including any in-memory approval. */
  async forgetApproval(workspaceId: string, actionId: string): Promise<void> {
    const commandId = commandIdentity({ kind: "action", actionId });
    await this.configuration?.forgetApproval(workspaceId, commandId);
    this.inMemoryApprovals.delete(`${workspaceId}:${commandId}`);
  }

  /** Approve the current shared command only when it still matches the script the user reviewed. */
  async approveCommand(input: WorkspaceEnvironmentCommandApproveInput): Promise<void> {
    const thread = this.requireSetupThread(input.threadId);
    this.assertApprovalAllowed(thread);
    const resolved = await this.resolveCommand(thread, input.target);
    try {
      if (resolved.kind !== "ready") {
          throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_APPROVAL_NOT_REQUIRED",
          "This Project command does not require shared-command approval",
        );
      }
      const approval = resolved.approval;
      if (approval === null) {
          throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_APPROVAL_NOT_REQUIRED",
          "This Project command does not require shared-command approval",
        );
      }
      if (approval.fingerprint !== input.fingerprint) {
          throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_APPROVAL_STALE",
          "The shared Project command changed before approval",
        );
      }
      this.assertApprovalAllowed(thread);
      await this.persistApproval(thread.workspace_id, approval);
    } finally {
      if (resolved.kind === "ready") await this.closeUnstartedCommand(resolved.command);
    }

  }

  /** Resolve one Action command and its approval state without starting a process. */
  async resolveActionCommand(threadId: string, actionId: string): Promise<WorkspaceEnvironmentCommandResolution> {
    return await this.resolveCommand(this.requireSetupThread(threadId), { kind: "action", actionId });
  }

  /**
   * Prepare every `runOnCleanup` Action in document order without starting any process.
   * Callers own each ready command: start it, or close it when they skip it.
   */
  async resolveCleanupCommands(
    threadId: string,
    bounds: WorkspaceEnvironmentCommandBounds,
  ): Promise<readonly WorkspaceEnvironmentActionCommandResolution[]> {
    const thread = this.requireSetupThread(threadId);
    const environment = await this.readForThread(thread);
    const resolutions: WorkspaceEnvironmentActionCommandResolution[] = [];
    for (const action of environment.document.actions) {
      if (!actionSchedule(action).cleanup) continue;
      resolutions.push(await this.resolveCleanupCommand(environment.storageMode, thread, action, bounds));
    }
    return resolutions;
  }

  private async resolveCleanupCommand(
    storageMode: WorkspaceEnvironmentStorageMode | undefined,
    thread: WorkspaceEnvironmentSetupThread,
    action: WorkspaceEnvironmentAction,
    bounds: WorkspaceEnvironmentCommandBounds,
  ): Promise<WorkspaceEnvironmentActionCommandResolution> {
    const platform = this.platform();
    const script = selectWorkspaceEnvironmentScript(action.command, platform);
    if (!script) return { ...unavailableCommandResolution(platform, action), action };
    const preparation = await this.prepareWorkspaceCommand(thread, script, bounds);
    const target: WorkspaceEnvironmentCommandTarget = { kind: "action", actionId: action.id };
    return { ...this.resolvePreparedCommand(storageMode, thread, target, platform, script, preparation, action), action };
  }

  /** Read and validate the selected Project environment document for the base checkout or one Thread checkout. */
  async read(workspaceId: string, threadId?: string): Promise<WorkspaceEnvironmentReadResult> {
    if (threadId) {
      const thread = this.requireSetupThread(threadId);
      if (thread.workspace_id !== workspaceId) {
        throw new WorkspaceEnvironmentServiceError(
          "WORKSPACE_ENVIRONMENT_NOT_FOUND",
          "Thread does not belong to this Project",
        );
      }
      return await this.readForThread(thread);
    }
    const storageMode = await this.storageMode(workspaceId);
    const filePath = this.filePathForWorkspace(workspaceId, storageMode);
    return await this.readAt(filePath, storageMode, workspaceId);
  }

  private async readForThread(thread: WorkspaceEnvironmentSetupThread): Promise<WorkspaceEnvironmentReadResult> {
    const storageMode = await this.storageMode(thread.workspace_id);
    const filePath = this.filePathForThread(thread, storageMode);
    return await this.readAt(filePath, storageMode, thread.workspace_id);
  }

  private async readAt(
    filePath: string,
    storageMode: WorkspaceEnvironmentStorageMode,
    workspaceId: string,
  ): Promise<WorkspaceEnvironmentReadResult> {
    const bounded = await this.readBounded(filePath);
    if (bounded.kind === "absent") {
      return {
        document: DEFAULT_WORKSPACE_ENVIRONMENT_DOCUMENT,
        revision: null,
        status: "absent",
        storageMode,
        approvedActionIds: storageMode === "shared" ? [] : undefined,
      };
    }
    if (bounded.kind === "too_large") {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace environment exceeds the maximum persisted size",
        [issue([], "DOCUMENT_TOO_LARGE", "document_too_large", `Environment documents must be at most ${WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES} bytes`)],
      );
    }
    const bytes = bounded.bytes;

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_VALIDATION",
        "Workspace environment is not valid JSON",
        [issue([], "INVALID_JSON", "invalid_value", "Workspace environment is not valid JSON")],
      );
    }
    let document: WorkspaceEnvironmentReadResult["document"];
    try {
      document = upgradeEnvironmentDocument(value);
    } catch (error) {
      if (error instanceof ZodError) throw validationError(error);
      throw error;
    }
    return {
      document,
      revision: revisionFor(bytes, storageMode, filePath),
      status: "present",
      storageMode,
      approvedActionIds: this.approvedActionIds(workspaceId, document, storageMode),
    };
  }

  private approvedActionIds(
    workspaceId: string,
    document: WorkspaceEnvironmentReadResult["document"],
    storageMode: WorkspaceEnvironmentStorageMode,
  ): string[] | undefined {
    if (storageMode !== "shared") return undefined;
    const commandIds = new Set(this.configuration?.listApprovedCommandIds(workspaceId));
    return document.actions
      .filter((action) => commandIds.has(commandIdentity({ kind: "action", actionId: action.id })))
      .map((action) => action.id);
  }

  private filePathForWorkspace(workspaceId: string, storageMode: WorkspaceEnvironmentStorageMode): string {
    if (storageMode === "system") return this.filePath(workspaceId);
    return NodePath.join(this.requireWorkspace(workspaceId).path, ".mcode", "environment.json");
  }

  private filePathForThread(
    thread: WorkspaceEnvironmentSetupThread,
    storageMode: WorkspaceEnvironmentStorageMode,
  ): string {
    if (storageMode === "system") return this.filePath(thread.workspace_id);
    const checkoutPath = thread.mode === "worktree" ? thread.worktree_path : this.requireWorkspace(thread.workspace_id).path;
    if (!checkoutPath) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_NOT_FOUND",
        "The shared Project environment checkout is unavailable",
      );
    }
    return NodePath.join(checkoutPath, ".mcode", "environment.json");
  }

  private requireWorkspace(workspaceId: string): WorkspaceEnvironmentWorkspace {
    const workspace = this.options.workspaces?.findById(workspaceId);
    if (workspace) return workspace;
    throw new WorkspaceEnvironmentServiceError(
      "WORKSPACE_ENVIRONMENT_NOT_FOUND",
      "Workspace was not found for shared Project configuration",
    );
  }

  private async storageMode(workspaceId: string): Promise<WorkspaceEnvironmentStorageMode> {
    const stored = this.configuration?.storageMode(workspaceId) ?? this.inMemoryStorageModes.get(workspaceId);
    if (stored) return stored;
    const workspace = this.options.workspaces?.findById(workspaceId);
    const storageMode = workspace && await this.hasValidSharedDocument(NodePath.join(workspace.path, ".mcode", "environment.json"))
      ? "shared"
      : "system";
    await this.persistStorageMode(workspaceId, storageMode);
    return storageMode;
  }

  private async persistStorageMode(workspaceId: string, storageMode: WorkspaceEnvironmentStorageMode): Promise<void> {
    if (this.configuration) await this.configuration.setStorageMode(workspaceId, storageMode);
    else this.inMemoryStorageModes.set(workspaceId, storageMode);
  }

  private async hasValidSharedDocument(filePath: string): Promise<boolean> {
    const bounded = await this.readBounded(filePath);
    if (bounded.kind !== "present") return false;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bounded.bytes));
      upgradeEnvironmentDocument(value);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveCommand(
    thread: WorkspaceEnvironmentSetupThread,
    target: WorkspaceEnvironmentCommandTarget,
  ): Promise<WorkspaceEnvironmentCommandResolution> {
    const platform = this.platform();
    const environment = await this.readForThread(thread);
    const action = this.resolveCommandAction(environment, target);
    const command = action.command;
    const script = command ? selectWorkspaceEnvironmentScript(command, platform) : null;
    if (!script) return unavailableCommandResolution(platform, action);
    const preparation = await this.prepareWorkspaceCommand(thread, script);
    return this.resolvePreparedCommand(environment.storageMode, thread, target, platform, script, preparation, action);
  }

  private resolveCommandAction(
    environment: WorkspaceEnvironmentReadResult,
    target: WorkspaceEnvironmentCommandTarget,
  ): WorkspaceEnvironmentAction {
    const action = environment.document.actions.find((candidate) => candidate.id === target.actionId) ?? null;
    if (!action) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_ACTION_NOT_FOUND",
        "Project Action not found",
      );
    }
    return action;
  }

  private async prepareWorkspaceCommand(
    thread: WorkspaceEnvironmentSetupThread,
    script: string,
    bounds: WorkspaceEnvironmentCommandBounds = { timeoutMs: 10 * 60 * 1000, outputMaxBytes: 512 * 1024 },
  ): Promise<TerminalCommandPreparation> {
    const terminalCommands = this.options.terminalCommands;
    if (!terminalCommands) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Project command execution is unavailable for this Thread",
      );
    }
    return terminalCommands.prepare({
      scope: { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id },
      script,
      timeoutMs: bounds.timeoutMs,
      outputMaxBytes: bounds.outputMaxBytes,
    });
  }

  private resolvePreparedCommand(
    storageMode: WorkspaceEnvironmentStorageMode | undefined,
    thread: WorkspaceEnvironmentSetupThread,
    target: WorkspaceEnvironmentCommandTarget,
    platform: WorkspaceEnvironmentPlatform,
    script: string,
    preparation: TerminalCommandPreparation,
    action: WorkspaceEnvironmentAction | null,
  ): WorkspaceEnvironmentCommandResolution {
    if (preparation.kind !== "ready") {
      return {
        kind: preparation.kind,
        output: preparation.output,
        snapshot: snapshotForPreparation(platform, script, preparation),
        action,
      };
    }
    const approval = storageMode === "shared"
      ? this.pendingApproval(thread.workspace_id, target, platform, script, preparation.command.snapshot)
      : null;
    return {
      kind: "ready",
      command: preparation.command,
      script,
      snapshot: snapshotForPreparation(platform, script, preparation, approval),
      approval,
      action,
    };
  }

  private pendingApproval(
    workspaceId: string,
    target: WorkspaceEnvironmentCommandTarget,
    platform: WorkspaceEnvironmentPlatform,
    script: string,
    snapshot: PreparedTerminalCommand["snapshot"],
  ): WorkspaceEnvironmentCommandApproval | null {
    const terminal = snapshot.terminal;
    if (!terminal) return null;
    const fingerprint = approvalFingerprint({ workspaceId, target, platform, script, terminal });
    return this.hasApproval(workspaceId, commandIdentity(target), fingerprint)
      ? null
      : { target, fingerprint };
  }

  private hasApproval(workspaceId: string, commandId: string, fingerprint: string): boolean {
    return this.configuration?.hasApproval(workspaceId, commandId, fingerprint)
      ?? this.inMemoryApprovals.get(`${workspaceId}:${commandId}`) === fingerprint;
  }

  private async persistApproval(workspaceId: string, approval: WorkspaceEnvironmentCommandApproval): Promise<void> {
    const commandId = commandIdentity(approval.target);
    if (this.configuration) await this.configuration.approve(workspaceId, commandId, approval.fingerprint);
    else this.inMemoryApprovals.set(`${workspaceId}:${commandId}`, approval.fingerprint);
  }

  private async readBounded(filePath: string): Promise<
    | { kind: "absent" }
    | { kind: "too_large" }
    | { kind: "present"; bytes: Uint8Array }
  > {
    let handle: Awaited<ReturnType<typeof NodeFSPromises.open>>;
    try {
      handle = await NodeFSPromises.open(filePath, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
      throw error;
    }
    const bytes = new Uint8Array(WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES + 1);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        offset += bytesRead;
        if (bytesRead === 0) break;
      }
      return offset > WORKSPACE_ENVIRONMENT_DOCUMENT_MAX_BYTES
        ? { kind: "too_large" }
        : { kind: "present", bytes: bytes.subarray(0, offset) };
    } finally {
      await handle.close();
    }
  }

  /** Validate and atomically replace the workspace environment when its revision is current. */
  async save(input: WorkspaceEnvironmentSaveInput): Promise<WorkspaceEnvironmentReadResult> {
    const parsed = WorkspaceEnvironmentDocumentSchema().safeParse(input.document);
    if (!parsed.success) throw validationError(parsed.error);
    try {
      return await this.enqueueSave(
        input.workspaceId,
        () => this.saveValidatedEnvironment(input, parsed.data),
      );
    } catch (error) {
      if (error instanceof ZodError) throw validationError(error);
      throw error;
    }
  }

  private async saveValidatedEnvironment(
    input: WorkspaceEnvironmentSaveInput,
    document: WorkspaceEnvironmentSaveInput["document"],
  ): Promise<WorkspaceEnvironmentReadResult> {
    const current = await this.read(input.workspaceId, input.threadId);
    this.assertCurrentEnvironmentRevision(current, input.sourceRevision);
    const thread = input.threadId ? this.requireSetupThread(input.threadId) : null;
    this.assertSaveThreadWorkspace(thread, input.workspaceId);
    const storageMode = current.storageMode ?? "system";
    const filePath = thread
      ? this.filePathForThread(thread, storageMode)
      : this.filePathForWorkspace(input.workspaceId, storageMode);
    const encoded = await this.writeEnvironmentDocument(filePath, document);
    return {
      document: encoded.document,
      revision: revisionFor(encoded.bytes, storageMode, filePath),
      status: "present",
      storageMode,
      approvedActionIds: this.approvedActionIds(input.workspaceId, encoded.document, storageMode),
    };
  }

  private assertCurrentEnvironmentRevision(
    current: WorkspaceEnvironmentReadResult,
    sourceRevision: string | null,
  ): void {
    if (current.revision !== sourceRevision) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_STALE",
        "Workspace environment changed since it was loaded",
      );
    }
  }

  private assertSaveThreadWorkspace(
    thread: WorkspaceEnvironmentSetupThread | null,
    workspaceId: string,
  ): void {
    if (thread && thread.workspace_id !== workspaceId) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_NOT_FOUND",
        "Thread does not belong to this Project",
      );
    }
  }

  private async writeEnvironmentDocument(
    filePath: string,
    document: WorkspaceEnvironmentSaveInput["document"],
  ): Promise<ReturnType<typeof encodeEnvironmentDocument>> {
    const encoded = encodeEnvironmentDocument(document);
    const directory = NodePath.dirname(filePath);
    await NodeFSPromises.mkdir(directory, { recursive: true });
    const temporaryPath = NodePath.join(directory, `.environment.${NodeCrypto.randomUUID()}.tmp`);
    try {
      await NodeFSPromises.writeFile(temporaryPath, encoded.bytes);
      await NodeFSPromises.rename(temporaryPath, filePath);
    } catch (error) {
      await this.removeTemporaryEnvironmentFile(temporaryPath);
      throw error;
    }
    return encoded;
  }

  private async removeTemporaryEnvironmentFile(filePath: string): Promise<void> {
    try {
      await NodeFSPromises.unlink(filePath);
    } catch {
      // Cleanup is limited to this operation's own temporary file.
    }
  }

  /** Blocks startup action starts while a Thread deletion is active. */
  beginThreadDeletion(threadId: string): () => void {
    return this.beginDeletion(this.deletingThreadCounts, threadId);
  }

  /** Blocks startup action starts while a workspace deletion is active. */
  beginWorkspaceDeletion(workspaceId: string): () => void {
    return this.beginDeletion(this.deletingWorkspaceCounts, workspaceId);
  }

  /** Cancel startup commands owned by one thread before deletion. */
  async cancelSetupForThread(threadId: string): Promise<void> {
    if (this.hasAutomaticSetupForThread(threadId)) await this.cancelAutomaticSetupForThread(threadId);
  }

  /** Cancel startup commands owned by a workspace before deletion. */
  async cancelSetupForWorkspace(workspaceId: string): Promise<void> {
    const threadIds = new Set([...this.startupRunners.keys(), ...this.startingAutomaticSetupPromises.keys()]
      .filter((threadId) => this.options.threads?.findById(threadId)?.workspace_id === workspaceId));
    await this.cancelSetupThreads(threadIds);
  }

  /** Stop startup command phases before server shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.disposePromise ??= this.interruptActiveAutomaticSetups();
    await this.disposePromise;
  }

  private async cancelSetupThreads(threadIds: ReadonlySet<string>): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(threadIds, (threadId) => this.cancelSetupForThread(threadId)),
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private requireAutomaticRepository(): WorkspaceEnvironmentAutomaticRepository {
    if (this.automaticRepository) return this.automaticRepository;
    throw new Error("Automatic Project Setup requires SQLite lifecycle storage");
  }

  private requireAutomaticSetupThread(threadId: string): WorkspaceEnvironmentSetupThread & { worktree_path: string } {
    const thread = this.requireSetupThread(threadId);
    if (
      this.disposed ||
      !isAutomaticSetupThread(thread) ||
      thread.deleted_at != null ||
      thread.cleanup_state != null ||
      this.deletingThreadCounts.has(thread.id) ||
      this.deletingWorkspaceCounts.has(thread.workspace_id)
    ) {
      throw new WorkspaceEnvironmentServiceError(
        "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
        "Automatic Setup is unavailable for this Thread",
      );
    }
    return thread;
  }

  private async startAutomaticSetup(thread: WorkspaceEnvironmentSetupThread): Promise<void> {
    const existing = this.startingAutomaticSetupPromises.get(thread.id);
    if (existing) return existing;
    if (this.isAutomaticSetupCancelled(thread.id)) {
      await this.requireAutomaticRepository().interruptCurrentAttempt(thread.id);
      await this.requireAutomaticRepository().cancelStartupTurns(thread.id);
      return Promise.resolve();
    }
    const starting = this.serializeAutomaticWorktreeSetup(thread);
    this.startingAutomaticSetupPromises.set(thread.id, starting);
    void starting.then(
      () => {
        if (this.startingAutomaticSetupPromises.get(thread.id) === starting) {
          this.startingAutomaticSetupPromises.delete(thread.id);
        }
      },
      () => {
        if (this.startingAutomaticSetupPromises.get(thread.id) === starting) {
          this.startingAutomaticSetupPromises.delete(thread.id);
        }
      },
    );
    return starting;
  }

  private async serializeAutomaticWorktreeSetup(thread: WorkspaceEnvironmentSetupThread): Promise<void> {
    if (!isAutomaticSetupThread(thread)) throw this.setupUnavailableError();
    const path = this.automaticWorktreePath(thread.worktree_path);
    const previous = this.automaticWorktreeTails.get(path);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.automaticWorktreeTails.set(path, tail);
    try {
      await previous;
      await this.runStartupActions(thread);
    } finally {
      release();
      if (this.automaticWorktreeTails.get(path) === tail) this.automaticWorktreeTails.delete(path);
    }
  }

  private automaticWorktreePath(path: string): string {
    return normalizeWorktreePath(path, this.platform() === "windows" ? "win32" : "linux");
  }

  private hasLiveWorktreeSibling(thread: WorkspaceEnvironmentSetupThread): boolean {
    if (!isAutomaticSetupThread(thread)) return false;
    const path = this.automaticWorktreePath(thread.worktree_path);
    const siblings = this.options.threads?.listAllByWorkspace?.(thread.workspace_id) ?? [];
    return siblings.some((sibling) => {
      if (sibling.id === thread.id || sibling.deleted_at != null || !sibling.worktree_path) return false;
      if (this.automaticWorktreePath(sibling.worktree_path) !== path) return false;
      return this.isWorktreeSiblingActive(sibling.id);
    });
  }

  private isWorktreeSiblingActive(threadId: string): boolean {
    const phase = this.options.runtimePhase?.(threadId);
    if (phase === "running" || phase === "finalizing") return true;
    const attempt = this.requireAutomaticRepository().snapshot(threadId).attempt?.state;
    if (attempt === "running") return true;
    if (!this.hasNonterminalStartup(threadId)) return false;
    // A passed sibling stays in the setup phase until its first turn claims the agent, so it is still live.
    // Undecided siblings serialize behind this start and must not make both starts skip.
    return attempt === "passed" || this.options.threadStartups?.findByThreadId(threadId)?.phase === "agent";
  }

  private launchAutomaticSetup(thread: WorkspaceEnvironmentSetupThread): void {
    void this.startAutomaticSetup(thread).catch(async (error: unknown) => {
      logger.error("Automatic Project Setup could not persist its transition", { threadId: thread.id, error: error instanceof Error ? error.message : String(error) });
      await this.blockStartupSetup(thread.id, "SETUP_PERSISTENCE_FAILED", "Project Setup could not save its state");
    }).catch((error: unknown) => {
      logger.error("Automatic Project Setup could not save its startup failure", { threadId: thread.id, error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async runStartupActions(thread: WorkspaceEnvironmentSetupThread): Promise<void> {
    const repository = this.requireAutomaticRepository();
    const snapshot = repository.snapshot(thread.id);
    const queuedAttemptId = queuedAutomaticAttemptId(snapshot);
    if (!queuedAttemptId) return;
    if (!this.isAutomaticAttemptReadyToStart(repository, thread.id, queuedAttemptId)) return;
    if (this.hasLiveWorktreeSibling(thread)) {
      await this.releaseAutomaticSetupWithoutCommand(repository, thread.id, queuedAttemptId, "thread-running-here");
      return;
    }
    const runner = this.createStartupRunner(thread.id, queuedAttemptId);
    await this.startFrozenStartupActions(thread, queuedAttemptId, runner);
  }

  private createStartupRunner(threadId: string, attemptId: string): StartupActionRunner {
    const repository = this.requireAutomaticRepository();
    const actions = this.options.projectActions?.();
    if (!actions) throw new Error("Startup actions require ProjectActionService");
    const runner = new StartupActionRunner({
      threadId: threadId, attemptId: attemptId, projectActions: actions,
      transition: async (transition) => {
        const result = await repository.transitionStartupActions(transition);
        if (result.startup) this.options.threadStartups?.publish(result.startup);
        return result.applied;
      },
      appendOutput: async (entries) => {
        const startup = this.options.threadStartups?.findByThreadId(threadId);
        if (startup?.phase === "setup") await this.options.threadStartups?.appendOutputs(startup.startupId, entries);
      },
      passed: async () => {
        this.startupRunners.delete(threadId);
        await this.drainReleasedAutomaticTurn(threadId);
      },
      onError: (error) => {
        logger.error("Startup action transition failed", { threadId: threadId, error: String(error) });
        void this.blockStartupSetup(threadId, "SETUP_PERSISTENCE_FAILED", "Project Setup could not save its state").catch((failure: unknown) => {
          logger.error("Startup failure could not be saved", { threadId, error: String(failure) });
        });
      },
    });
    this.startupRunners.set(threadId, runner);
    return runner;
  }

  private async startFrozenStartupActions(thread: WorkspaceEnvironmentSetupThread, queuedAttemptId: string, runner: StartupActionRunner): Promise<void> {
    const repository = this.requireAutomaticRepository();
    const environment = await this.readStartupEnvironment(thread, queuedAttemptId, runner);
    if (!environment) return;
    if (!this.isAutomaticAttemptReadyToStart(repository, thread.id, queuedAttemptId)) {
      await runner.cancel();
      this.startupRunners.delete(thread.id);
      return;
    }
    const startupActions = environment.document.actions.flatMap((action) => {
      const startup = actionSchedule(action).startup;
      return startup ? [{ action, gate: startup.gate }] : [];
    });
    if (!startupActions.length) {
      await runner.cancel();
      this.startupRunners.delete(thread.id);
      await this.releaseAutomaticSetupWithoutCommand(repository, thread.id, queuedAttemptId);
      return;
    }
    const detail = this.options.threadStartups?.findByThreadId(thread.id)?.steps.find((step) => step.phase === "setup")?.detail;
    await runner.start(startupActions.map(({ action, gate }) => ({
      actionId: action.id, script: selectWorkspaceEnvironmentScript(action.command, this.platform()), gate,
    })), detail?.phase === "setup" ? detail.actions ?? [] : []);
  }

  private async readStartupEnvironment(thread: WorkspaceEnvironmentSetupThread, queuedAttemptId: string, runner: StartupActionRunner): Promise<WorkspaceEnvironmentReadResult | null> {
    const repository = this.requireAutomaticRepository();
    try {
      return await this.readForThread(thread);
    } catch (error) {
      const result = await repository.transitionStartupActions({
        threadId: thread.id, attemptId: queuedAttemptId, state: "failed", actions: [],
        detail: error instanceof Error ? error.message : String(error),
      });
      if (result.startup) this.options.threadStartups?.publish(result.startup);
      await runner.cancel();
      this.startupRunners.delete(thread.id);
      return null;
    }
  }

  private isAutomaticAttemptReadyToStart(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
  ): boolean {
    return this.isAutomaticAttemptQueued(repository, threadId, attemptId)
      && this.isAutomaticSetupAdmissionAllowed(threadId);
  }

  private async releaseAutomaticSetupWithoutCommand(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
    skipReason: "not-configured" | "thread-running-here" = "not-configured",
  ): Promise<void> {
    await this.skipStartupSetup(threadId, skipReason);
    await repository.releaseWithoutSetup(threadId, attemptId);
    await this.drainReleasedAutomaticTurn(threadId);
  }

  private async blockStartupSetup(threadId: string, code: string, message: string, exitCode?: number): Promise<void> {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    if (!startup || startup.phase !== "setup" || startup.state !== "running") return;
    // Retry setup keeps the transcript, so earlier attempts' output must not explain this block.
    const attemptStartedAt = startup.steps.find((step) => step.phase === "setup")?.startedAt ?? "";
    const detail = startup.transcript
      .filter((entry) => entry.phase === "setup" && entry.createdAt >= attemptStartedAt)
      .map((entry) => entry.content).join("").split(/\r?\n/)
      .reverse().find((line) => line.trim())?.trim().slice(0, 2_000);
    await this.options.threadStartups?.block(startup.startupId,
      { code, message, detail, actions: ["retry", "continue"] },
      { ...startup.steps.find((step) => step.phase === "setup")?.detail, phase: "setup", exitCode });
  }

  private async skipStartupSetup(threadId: string, skipReason: "not-configured" | "user-skipped" | "thread-running-here" | "plan-implement"): Promise<void> {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    if (!startup || startup.phase !== "setup") return;
    if (startup.state !== "running" && startup.state !== "blocked" && startup.state !== "interrupted") return;
    await this.options.threadStartups?.skip(startup.startupId, "setup", { ...startup.steps.find((step) => step.phase === "setup")?.detail, phase: "setup", skipReason });
  }

  /**
   * Settle a startup record that can no longer advance itself after a gate
   * release. Interrupted records complete (or honour a pending cancellation);
   * an agent phase with no Turn left to dispatch is done. Once a Turn was
   * dispatched, its provider's first frame or early end settles the startup
   * through StartupAgentPhaseObserver instead.
   */
  private async settleStartupAfterDrain(threadId: string): Promise<void> {
    const startups = this.options.threadStartups;
    const startup = startups?.findByThreadId(threadId);
    if (!startup || !this.isSettleableStartup(startup)) return;
    if (startup.cancellation === "requested") {
      await startups?.markCancelled(startup.startupId);
      return;
    }
    if (startup.state === "interrupted"
      || (!this.hasPendingAutomaticTurns(threadId) && !this.hasDispatchedAutomaticTurn(threadId))) {
      await startups?.complete(startup.startupId);
    }
  }

  private isSettleableStartup(startup: ThreadStartup): boolean {
    return startup.state === "interrupted"
      || (startup.state === "running" && startup.phase === "agent");
  }

  /**
   * Settle interrupted startups whose Setup attempt can no longer offer a
   * recovery action, for example when the process died before the gate existed
   * or after it was already released. Nothing else can advance them.
   */
  private async settleInterruptedStartups(
    repository: WorkspaceEnvironmentAutomaticRepository,
  ): Promise<void> {
    for (const startup of this.options.threadStartups?.listInterrupted() ?? []) {
      if (!startup.threadId) continue;
      const snapshot = repository.snapshot(startup.threadId);
      const attempt = snapshot.attempt;
      // A released gate means the user already decided; a blocked gate with a
      // recoverable attempt still offers Continue/Retry and owns the record.
      const recoverable = attempt && (
        attempt.state === "awaiting-approval"
        || attempt.state === "failed"
        || attempt.state === "interrupted"
      );
      if (snapshot.gate === "blocked" && recoverable) continue;
      await this.settleStartupAfterDrain(startup.threadId);
    }
  }

  private hasDispatchedAutomaticTurn(threadId: string): boolean {
    return this.requireAutomaticRepository().snapshot(threadId).queuedTurns.some((turn) => turn.state === "dispatched");
  }

  private hasPendingAutomaticTurns(threadId: string): boolean {
    return this.requireAutomaticRepository().snapshot(threadId).queuedTurns
      .some((turn) => turn.state === "queued" || turn.state === "released" || turn.state === "dispatching");
  }

  private async interruptActiveAutomaticSetups(): Promise<void> {
    if (!this.automaticRepository) return;
    await this.automaticRepository.interruptUnfinishedAttempts();
    await Promise.all(this.startingAutomaticSetupPromises.values());
    await Promise.all([...this.startupRunners.values()].map((runner) => runner.cancel()));
    this.startupRunners.clear();
    await Promise.all(this.automaticDrainLoops.values());
  }

  private isAutomaticAttemptQueued(
    repository: WorkspaceEnvironmentAutomaticRepository,
    threadId: string,
    attemptId: string,
  ): boolean {
    const snapshot = repository.snapshot(threadId);
    return snapshot.gate === "blocked"
      && snapshot.attempt?.id === attemptId
      && snapshot.attempt.state === "queued";
  }

  private isAutomaticSetupAdmissionAllowed(threadId: string): boolean {
    if (this.isAutomaticSetupCancelled(threadId)) return false;
    try {
      this.requireAutomaticSetupThread(threadId);
      return true;
    } catch (error) {
      if (error instanceof WorkspaceEnvironmentServiceError) return false;
      throw error;
    }
  }

  private isAutomaticSetupCancelled(threadId: string): boolean {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    return startup?.cancellation === "requested" || startup?.state === "cancelled";
  }

  private hasAutomaticSetupForThread(threadId: string): boolean {
    if (!this.automaticRepository) return false;
    return this.automaticRepository.snapshot(threadId).gate === "blocked"
      || this.startupRunners.has(threadId)
      || this.startingAutomaticSetupPromises.has(threadId)
      || this.automaticDrainLoops.has(threadId);
  }

  private async cancelAutomaticSetupForThread(threadId: string): Promise<void> {
    const stopping = this.automaticStopPromises.get(threadId);
    if (stopping) await stopping;
    await this.interruptAutomaticSetupResources(threadId);
    await this.automaticDrainLoops.get(threadId);
  }

  private async drainReleasedAutomaticTurn(threadId?: string): Promise<void> {
    const dispatcher = this.automaticDispatcher;
    if (!dispatcher) return;
    const repository = this.requireAutomaticRepository();
    if (threadId) {
      await this.startAutomaticDrain(threadId, repository, dispatcher);
      await this.settleStartupAfterDrain(threadId);
      return;
    }
    await Promise.all(repository.releasedThreadIds().map(async (releasedThreadId) => {
      await this.startAutomaticDrain(releasedThreadId, repository, dispatcher);
      await this.settleStartupAfterDrain(releasedThreadId);
    }));
  }

  private startAutomaticDrain(
    threadId: string,
    repository: WorkspaceEnvironmentAutomaticRepository,
    dispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher,
  ): Promise<void> {
    const existing = this.automaticDrainLoops.get(threadId);
    if (existing) {
      void existing.then(() => this.drainReleasedAutomaticTurn(threadId));
      return Promise.resolve();
    }
    let resolveFirstDispatch!: () => void;
    const firstDispatch = new Promise<void>((resolve) => { resolveFirstDispatch = resolve; });
    const loop = this.drainAutomaticThread(threadId, repository, dispatcher, resolveFirstDispatch);
    this.automaticDrainLoops.set(threadId, loop);
    void loop.then(
      () => {
        if (this.automaticDrainLoops.get(threadId) === loop) this.automaticDrainLoops.delete(threadId);
      },
      () => {
        if (this.automaticDrainLoops.get(threadId) === loop) this.automaticDrainLoops.delete(threadId);
      },
    );
    return firstDispatch;
  }

  private async drainAutomaticThread(
    threadId: string,
    repository: WorkspaceEnvironmentAutomaticRepository,
    dispatcher: WorkspaceEnvironmentAutomaticSetupDispatcher,
    resolveFirstDispatch: () => void,
  ): Promise<void> {
    let firstDispatchResolved = false;
    const resolveWhenResponsive = () => {
      if (firstDispatchResolved) return;
      firstDispatchResolved = true;
      resolveFirstDispatch();
    };
    for (;;) {
      try {
        if (!this.isAutomaticSetupAdmissionAllowed(threadId)) {
          resolveWhenResponsive();
          return;
        }
        const claimed = await repository.claimReleasedTurn(threadId);
        if (!claimed) {
          resolveWhenResponsive();
          return;
        }
        const accepted = await dispatcher.dispatch(claimed.submission);
        await repository.markDispatched(claimed.id);
        resolveWhenResponsive();
        await accepted.completion.catch(() => undefined);
      } catch (error) {
        // A malformed or provider-uncertain claim must never be replayed automatically.
        logger.warn("Released automatic Setup Turn dispatch failed; the claim is left unacknowledged", {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        resolveWhenResponsive();
        return;
      }
    }
  }

  private invalidateAutomaticRetry(threadId: string): void {
    this.automaticStopGenerations.set(threadId, (this.automaticStopGenerations.get(threadId) ?? 0) + 1);
  }

  private runAutomaticRecoveryOperation<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.automaticRecoveryOperationTails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.automaticRecoveryOperationTails.set(threadId, tail);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.automaticRecoveryOperationTails.get(threadId) === tail) {
          this.automaticRecoveryOperationTails.delete(threadId);
        }
        this.clearAutomaticRecoveryGeneration(threadId);
      });
  }

  private clearAutomaticRecoveryGeneration(threadId: string): void {
    if (!this.automaticRecoveryOperationTails.has(threadId) && !this.automaticStopPromises.has(threadId)) {
      this.automaticStopGenerations.delete(threadId);
    }
  }

  private enqueueSave<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.saveTails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.saveTails.set(workspaceId, current);
    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.saveTails.get(workspaceId) === current) this.saveTails.delete(workspaceId);
      });
  }

  private requireSetupThread(threadId: string): WorkspaceEnvironmentSetupThread {
    const thread = this.options.threads?.findById(threadId);
    if (thread) return thread;
    throw new WorkspaceEnvironmentServiceError(
      "WORKSPACE_ENVIRONMENT_NOT_FOUND",
      "Thread was not found for startup actions",
    );
  }

  private hasNonterminalStartup(threadId: string): boolean {
    const startup = this.options.threadStartups?.findByThreadId(threadId);
    return startup?.state === "pending" || startup?.state === "running" || startup?.state === "blocked";
  }

  private setupUnavailableError(): WorkspaceEnvironmentServiceError {
    return new WorkspaceEnvironmentServiceError(
      "WORKSPACE_ENVIRONMENT_SETUP_UNAVAILABLE",
      "Startup actions are unavailable for this Thread",
    );
  }

  private beginDeletion(counts: Map<string, number>, id: string): () => void {
    counts.set(id, (counts.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = counts.get(id);
      if (count === undefined || count <= 1) counts.delete(id);
      else counts.set(id, count - 1);
    };
  }

  private async closeUnstartedCommand(command: PreparedTerminalCommand): Promise<void> {
    const result = await command.close();
    if (result.kind === "containment_failure") {
      throw new Error("Project Setup command could not be cancelled before it started");
    }
  }

  private assertApprovalAllowed(thread: WorkspaceEnvironmentSetupThread): void {
    if (
      thread.deleted_at !== null && thread.deleted_at !== undefined ||
      thread.cleanup_state !== null && thread.cleanup_state !== undefined ||
      this.deletingThreadCounts.has(thread.id) ||
      this.deletingWorkspaceCounts.has(thread.workspace_id)
    ) {
      throw this.setupUnavailableError();
    }
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

}

function commandIdentity(target: WorkspaceEnvironmentCommandTarget): string {
  return `action:${target.actionId}`;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n|\r/g, "\n");
}

function approvalFingerprint(input: {
  readonly workspaceId: string;
  readonly target: WorkspaceEnvironmentCommandTarget;
  readonly platform: WorkspaceEnvironmentPlatform;
  readonly script: string;
  readonly terminal: NonNullable<PreparedTerminalCommand["snapshot"]["terminal"]>;
}): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify({
    contractVersion: WORKSPACE_ENVIRONMENT_APPROVAL_CONTRACT_VERSION,
    projectIdentity: input.workspaceId,
    commandIdentity: commandIdentity(input.target),
    operatingSystem: input.platform,
    resolvedScript: normalizeLineEndings(input.script),
    terminalExecutable: input.terminal.executable,
    terminalArguments: input.terminal.arguments.map(normalizeLineEndings),
  })).digest("hex");
}

function requireWorkspaceEnvironmentPlatform(
  platform: WorkspaceEnvironmentPlatform | undefined,
): WorkspaceEnvironmentPlatform {
  if (platform) return platform;
  throw new Error("Workspace environment platform is required");
}

/** Selects the non-empty platform override or the non-empty default command. */
export function selectWorkspaceEnvironmentScript(
  command: WorkspaceEnvironmentCommand,
  platform: WorkspaceEnvironmentPlatform,
): string | null {
  const override = command[platform];
  if (typeof override === "string" && override.trim().length > 0) return override;
  const defaultScript = command.default;
  return typeof defaultScript === "string" && defaultScript.trim().length > 0 ? defaultScript : null;
}

function unavailableSnapshot(
  platform: WorkspaceEnvironmentPlatform,
  script: string | null,
): WorkspaceEnvironmentActionLaunchSnapshot {
  return { platform, script, checkoutPath: null, terminal: null, approval: null, environmentNames: [] };
}

function snapshotForPreparation(
  platform: WorkspaceEnvironmentPlatform,
  script: string,
  preparation: TerminalCommandPreparation,
  approval: WorkspaceEnvironmentCommandApproval | null = null,
): WorkspaceEnvironmentActionLaunchSnapshot {
  const snapshot = preparation.kind === "ready" ? preparation.command.snapshot : preparation.snapshot;
  return {
    platform,
    script,
    environmentNames: [],
    checkoutPath: snapshot.checkoutPath,
    terminal: snapshot.terminal
      ? { executable: snapshot.terminal.executable, arguments: [...snapshot.terminal.arguments] }
      : null,
    approval,
  };
}
