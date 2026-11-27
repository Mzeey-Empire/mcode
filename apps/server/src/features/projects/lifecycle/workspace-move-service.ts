import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  CreateProjectFromFolderInput, CreateProjectFromFolderResult, WorkspaceMoveFrame,
  WorkspaceMoveFailureCause, WorkspaceMoveRetryGitResult, WorkspaceMoveStatusInput,
} from "@mcode/contracts/ws/workspace-move";
import type { Workspace } from "@mcode/contracts/models/workspace";
import type { Thread } from "@mcode/contracts/models/thread";
import { logger } from "@mcode/shared";
import { DatabaseWriteOutcomeUnknown, type ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import type { BackgroundCommandStore } from "../../agents/background/background-command-store.js";
import type { TurnRuntimeController } from "../../agents/orchestration/turn-runtime-controller.js";
import type { AgentWorkload } from "../../agents/workload/agent-workload.js";
import type { TerminalBackend } from "../../terminal/backends/terminal-backend.js";
import type { ThreadControlMutationReservationService } from "../../thread-control/authority/thread-control-mutation-reservation-service.js";
import type { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { isOpenNoProjectThread } from "../../thread-control/persistence/thread-store.js";
import type { GitExecutor } from "../git/execution/index.js";
import { workspaceMoveWrites, type WorkspaceMove, type WorkspaceMoveStore } from "../persistence/workspace-move-store.js";
import type { WorkspaceRepo } from "../persistence/workspace-repo.js";
import { noProjectRetentionDeadline } from "../persistence/workspace-store.js";
import { copyWorkspaceFolder } from "./workspace-move-copy.js";
import {
  assertRecordedParent, holdsMoveMarker, inspectMoveFolder, markerPath, moveError, moveErrorCode, moveFailureCause,
  removeMoveClaim, removeMoveCopy, removeMoveMarker, renameWorkspaceFolder, resolveWorkspaceMovePaths, writeMoveMarker,
  type MoveFolderState,
} from "./workspace-move-files.js";
import { acquireWorkspaceMoveGate, isInsideMoveSource } from "./workspace-move-gate.js";
import { cleanRetainedMoveSource, type WorkspaceMoveDeleteOptions } from "./workspace-move-retention.js";

type Placement = Parameters<WorkspaceMoveStore["convert"]>[1];
type Receipt = Parameters<WorkspaceMoveStore["advance"]>[2];
type RollbackAction = "rename-back" | "remove-claim" | "finish";
type MoveFailure = { error: string; cause: WorkspaceMoveFailureCause };
type LiveMove = { claimedDestination: boolean; createdStaging: boolean; crossDrive: boolean };

// Intent and renamed use the same observations because the phase write can lag the rename.
const rollbackActions: Partial<Record<MoveFolderState, Partial<Record<MoveFolderState, RollbackAction>>>> = {
  missing: { "marker-only": "rename-back", owned: "rename-back" },
  empty: { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
  "marker-only": { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
  owned: { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
  foreign: { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
};

type CopyRollback = "finish" | "remnants" | "staging" | "published";
type CopyRollbackTable = Partial<Record<MoveFolderState, Partial<Record<MoveFolderState, CopyRollback>>>>;
const leftoverStaging: Partial<Record<MoveFolderState, CopyRollback>> = {
  missing: "staging", empty: "staging", "marker-only": "staging", foreign: "staging", other: "staging",
};
const unmarkedStaging: Partial<Record<MoveFolderState, CopyRollback>> = {
  missing: "finish", empty: "remnants", "marker-only": "remnants", foreign: "finish", other: "finish",
};
const beforeCopy: CopyRollbackTable = {
  missing: { missing: "finish", empty: "remnants", "marker-only": "remnants" },
  empty: leftoverStaging,
  "marker-only": leftoverStaging,
  owned: leftoverStaging,
  foreign: unmarkedStaging,
  other: unmarkedStaging,
};
const missingAfterCopy: Partial<Record<MoveFolderState, CopyRollback>> = {
  ...unmarkedStaging, owned: "published",
};
const copyRollbackByPhase: Partial<Record<WorkspaceMove["phase"], CopyRollbackTable>> = {
  intent: beforeCopy,
  copying: beforeCopy,
  copied: { ...beforeCopy, missing: missingAfterCopy },
  published: { missing: missingAfterCopy },
};

async function rollbackCopy(input: {
  move: WorkspaceMove;
  stagingPath: string;
  source: MoveFolderState;
  staging: MoveFolderState;
  destination: MoveFolderState;
  live?: LiveMove;
}): Promise<boolean> {
  const { move, stagingPath, source, destination, live } = input;
  if (!holdsMoveMarker(source)) throw new Error("The copy source no longer holds its move marker");
  const staging = observedStaging(input.staging, live);
  const action = copyRollbackAction(move.phase, staging, destination, live);
  if (action === "published") await removeMoveCopy(move.destinationPath, move.id);
  if (action === "staging") {
    if (staging === "empty") await removeMoveClaim(stagingPath, move.id);
    else await removeMoveCopy(stagingPath, move.id);
  }
  await removeCopyClaim(move, action, destination, live);
  return staging !== "foreign" && staging !== "other";
}

function observedStaging(staging: MoveFolderState, live?: LiveMove): MoveFolderState {
  return live && !live.createdStaging && staging !== "missing" ? "foreign" : staging;
}

function copyRollbackAction(
  phase: WorkspaceMove["phase"], staging: MoveFolderState, destination: MoveFolderState, live?: LiveMove,
): CopyRollback {
  const action = copyRollbackByPhase[phase]?.[staging]?.[destination];
  if (action) return action;
  // A live failure before a second claim can leave a destination created by someone else.
  if (live && !live.claimedDestination && staging === "missing" && (destination === "foreign" || destination === "other")) {
    return "finish";
  }
  throw new Error("The recorded copy paths do not identify a safe rollback");
}

async function removeCopyClaim(move: WorkspaceMove, action: CopyRollback, destination: MoveFolderState, live?: LiveMove): Promise<void> {
  if (action !== "remnants" && action !== "staging") return;
  if (destination !== "empty" && destination !== "marker-only") return;
  const mayHaveClaimed = live?.claimedDestination ?? (!move.claimReleased || move.phase === "copied" || move.phase === "published");
  if (mayHaveClaimed) await removeMoveClaim(move.destinationPath, move.id);
}

function visibleMoveResult(move: WorkspaceMove): WorkspaceMove["result"] {
  const { result } = move;
  if (!result || (move.phase !== "done" && result.status !== "rollback-pending")) return null;
  if ((result.status === "failed" || result.status === "rollback-pending") && !result.cause) {
    return { ...result, cause: { kind: "other" } };
  }
  return result;
}

function interruptedMoveFailure(move: WorkspaceMove): MoveFailure {
  const pending = move.result?.status === "rollback-pending" ? move.result : null;
  return {
    error: move.error ?? "The server stopped before the folder move committed",
    cause: pending?.cause ?? { kind: "other" },
  };
}

function moveFrame(move: WorkspaceMove): WorkspaceMoveFrame {
  const result = visibleMoveResult(move);
  return {
    operationId: move.id, revision: move.revision, phase: move.phase,
    copiedBytes: move.phase === "copying" ? move.copiedBytes : null,
    totalBytes: move.phase === "copying" ? move.totalBytes : null,
    ...(result ? { result } : {}),
  };
}

type MoveDeps = WorkspaceMoveDeleteOptions & {
  store: WorkspaceMoveStore;
  writer: Pick<ApplicationDatabaseWriter, "execute">;
  workspaces: WorkspaceRepo;
  threads: ThreadRepo;
  reservations: ThreadControlMutationReservationService;
  runtime: Pick<TurnRuntimeController, "evictThreadProviderSessions">;
  terminals: Pick<TerminalBackend, "listActiveSessions" | "kill">;
  git: GitExecutor;
  backgroundCommands: Pick<BackgroundCommandStore, "list">;
  agentWorkload: Pick<AgentWorkload, "backgroundSubagentThreadIds">;
  claimDestination?: (path: string) => Promise<void>;
  openCopyDestination?: typeof NodeFSPromises.open;
  publishProgress(frame: WorkspaceMoveFrame): void;
  publishConverted(workspace: Workspace, sharers: ReturnType<WorkspaceMoveStore["convert"]>): void;
  now?: () => Date;
};

/** Convert a managed workspace with a recoverable protocol around its rename or copy. */
export class WorkspaceMoveService {
  private readonly root: string;
  private readonly cleaning = new Set<string>();

  constructor(mcodeDir: string, private readonly deps: MoveDeps) {
    this.root = NodePath.join(mcodeDir, "no-project");
  }

  /** Reserve all sharers and return a durable operation before changing the disk. */
  async createProject(input: CreateProjectFromFolderInput): Promise<CreateProjectFromFolderResult> {
    const thread = this.deps.threads.findById(input.threadId);
    const workspace = thread && this.deps.workspaces.findById(thread.workspace_id);
    if (!workspace || workspace.kind !== "no_project") {
      return { status: "failed", error: "The thread has no managed No project folder", cause: { kind: "other" } };
    }
    const releaseGate = acquireWorkspaceMoveGate(workspace.id, workspace.path);
    if (!releaseGate) return { status: "failed", error: "The workspace is already being changed", cause: { kind: "other" } };
    const reservations = new Map<string, string>();
    const release = () => {
      for (const [id, token] of reservations) this.deps.reservations.release(id, token);
      releaseGate();
    };
    let scheduled = false;
    try {
      const sharers = this.deps.threads.listAllByWorkspace(workspace.id).filter((candidate) => candidate.deleted_at === null);
      const busy = this.reserveSharers(sharers, reservations);
      if (busy) return busy;
      const paths = await this.preparePaths(thread, workspace, input);
      const id = NodeCrypto.randomUUID();
      await this.deps.writer.execute(workspaceMoveWrites.start, [{
        id, workspaceId: workspace.id, name: input.name, initGit: input.initGit, createdAt: this.now(), ...paths,
      }, [...reservations.keys()]]);
      const move = this.requireMove(id);
      this.deps.publishProgress(moveFrame(move));
      setImmediate(() => {
        void this.run(move, reservations).catch((error: unknown) => this.logFailure(move, error)).finally(release);
      });
      scheduled = true;
      return { operationId: id };
    } catch (error) {
      return { status: "failed", ...await this.failure(error, NodePath.join(input.parentPath, input.name)) };
    } finally {
      if (!scheduled) release();
    }
  }

  /** Read the newest operation revision, or find an unfinished move through any sharer. */
  status(input: WorkspaceMoveStatusInput): WorkspaceMoveFrame | null {
    if ("operationId" in input) {
      const move = this.deps.store.find(input.operationId);
      return move ? moveFrame(move) : null;
    }
    const thread = this.deps.threads.findById(input.threadId);
    const move = thread && this.deps.store.findUnfinished(thread.workspace_id);
    return move ? moveFrame(move) : null;
  }

  /** Reconcile each recorded operation before the server starts serving turns or sweeping folders. */
  async recoverAtStartup(): Promise<void> {
    for (const move of this.deps.store.listRecoverable()) {
      const release = acquireWorkspaceMoveGate(move.workspaceId, move.sourcePath);
      if (!release) throw new Error("Workspace move gate was held during startup recovery");
      try {
        await this.recover(move);
      } catch (error) {
        this.logFailure(move, error);
      } finally {
        release();
      }
    }
    await this.cleanExpiredSources();
  }

  /** Retry due source cleanup without fencing the converted project. */
  async cleanExpiredSources(now = this.now()): Promise<void> {
    for (const move of this.deps.store.listExpiredSources(now)) {
      if (this.cleaning.has(move.id)) continue;
      this.cleaning.add(move.id);
      try {
        const current = this.requireMove(move.id);
        if (current.cleanup === "pending") await this.cleanSource(current, now);
      } catch (error) {
        this.logFailure(move, error);
      } finally {
        this.cleaning.delete(move.id);
      }
    }
  }

  /** Whether the orphan sweep must leave this path alone, even after cleanup has finished. */
  protectsFolder(path: string): boolean {
    return this.deps.store.protectsFolder(path);
  }

  private async cleanSource(move: WorkspaceMove, now: string): Promise<void> {
    const checkpoint = (next: Parameters<WorkspaceMoveStore["sourceCleanup"]>[1]) =>
      this.deps.writer.execute(workspaceMoveWrites.sourceCleanup, [move.id, next, now]);
    const outcome = await cleanRetainedMoveSource({
      move, options: this.deps, checkpoint, readManifest: () => this.deps.store.readManifest(move.id),
    });
    await checkpoint({ ...outcome, cleanupError: "cleanupError" in outcome ? outcome.cleanupError : null });
    if (outcome.cleanup !== "done") {
      const current = this.requireMove(move.id);
      logger.warn("Retained workspace source was not deleted", {
        operationId: move.id, path: current.tombstonePath ?? move.sourcePath, ...outcome,
      });
    }
  }

  /** Recover an unfinished row under the same gate before either deletion entry point proceeds. */
  async withDeletion(workspaceId: string, remove: () => Promise<boolean>): Promise<boolean> {
    const move = this.deps.store.findUnfinished(workspaceId);
    const release = acquireWorkspaceMoveGate(workspaceId, move?.sourcePath ?? null);
    if (!release) return false;
    try {
      if (move) {
        try {
          await this.recover(move);
        } catch (error) {
          this.logFailure(move, error);
          return false;
        }
        if (this.deps.store.findUnfinished(workspaceId)) return false;
      }
      return await remove();
    } finally {
      release();
    }
  }

  /** Retry only Git initialization for a project created by this operation. */
  async retryGit(id: string): Promise<WorkspaceMoveRetryGitResult> {
    const move = this.deps.store.find(id);
    if (!move?.initGit || move.result?.status !== "git-failed" || move.phase !== "done") {
      return { status: "failed", error: "This operation has no Git initialization to retry" };
    }
    const release = acquireWorkspaceMoveGate(move.workspaceId, null);
    if (!release) return { status: "failed", error: "The workspace is already being changed" };
    try {
      this.assertGitRetryProject(move);
      const { result, git } = await this.initializeGit(move);
      // Retrying Git updates the receipt, but does not emit a second terminal frame for the move.
      await this.save(move, { result, error: result.status === "git-failed" ? result.error : null }, git, false);
      this.publishProject(move, []);
      return result;
    } catch (error) {
      return { status: "failed", error: moveError(error) };
    } finally {
      release();
    }
  }

  private assertGitRetryProject(move: WorkspaceMove): void {
    const workspace = this.deps.workspaces.findById(move.workspaceId);
    if (workspace?.kind !== "project" || workspace.path !== move.destinationPath || workspace.is_git_repo) {
      throw new Error("The converted project is unavailable or already has Git");
    }
  }

  private async preparePaths(thread: Thread | null, workspace: Workspace, input: CreateProjectFromFolderInput) {
    if (!isOpenNoProjectThread(thread, workspace)) throw new Error("The thread must be an open No project thread");
    if (this.deps.store.findUnfinished(workspace.id)) throw new Error("The workspace has an unfinished move");
    const name = input.name.toLowerCase();
    if (this.deps.workspaces.listAll().some((project) => project.kind === "project" && project.name.toLowerCase() === name)) {
      throw new Error("A project with this name already exists");
    }
    return resolveWorkspaceMovePaths({
      workspaceId: workspace.id, storedSource: workspace.path, root: this.root, parentPath: input.parentPath, name: input.name,
    });
  }

  private reserveSharers(sharers: Thread[], reserved: Map<string, string>): Extract<CreateProjectFromFolderResult, { status: "busy" }> | null {
    for (const { id } of sharers) {
      const token = this.deps.reservations.reserve(id, "moving");
      if (!token) {
        const holder = this.deps.reservations.get(id)?.state;
        return { status: "busy", threadId: id, reason: holder === "pendingApproval" ? "needs-approval" : "running" };
      }
      reserved.set(id, token);
    }
    const subagents = this.deps.agentWorkload.backgroundSubagentThreadIds();
    for (const id of reserved.keys()) {
      if (subagents.has(id) || this.deps.backgroundCommands.list(id, { running: true }).length > 0) {
        return { status: "busy", threadId: id, reason: "background" };
      }
    }
    return null;
  }

  private async closeFolderUsers(workspaceId: string, sourcePath: string, sharers: ReadonlyMap<string, string>): Promise<void> {
    for (const id of sharers.keys()) await this.deps.runtime.evictThreadProviderSessions(id);
    for (const terminal of this.deps.terminals.listActiveSessions()) {
      const relocation = this.deps.threads.readRelocation(terminal.threadId);
      if (sharers.has(terminal.threadId) || relocation?.workspaceId === workspaceId
        || (terminal.cwd && isInsideMoveSource(sourcePath, terminal.cwd))) {
        await this.deps.terminals.kill(terminal.ptyId);
      }
    }
  }

  private async run(intent: WorkspaceMove, reservations: ReadonlyMap<string, string>): Promise<void> {
    const live: LiveMove = { claimedDestination: false, createdStaging: false, crossDrive: false };
    let converted: ReturnType<WorkspaceMoveStore["convert"]>;
    try {
      await this.closeFolderUsers(intent.workspaceId, intent.sourcePath, reservations);
      await writeMoveMarker(intent.sourcePath, intent.id);
      await this.moveFolder(intent, live);
      const git = await this.gitPlacement(intent.destinationPath);
      converted = await this.deps.writer.execute(workspaceMoveWrites.convert, [intent.id, git ?? { isGitRepo: false, branch: "main" }, this.now()]);
    } catch (error) {
      // An unknown commit outcome may still succeed on the writer. Only startup can safely decide.
      if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
      await this.rollback(this.requireMove(intent.id), await this.failure(error, intent.destinationPath), live);
      return;
    }
    const move = this.requireMove(intent.id);
    this.deps.publishProgress(moveFrame(move));
    await this.finishConverted(move, converted);
  }

  private async moveFolder(move: WorkspaceMove, live: LiveMove): Promise<void> {
    await this.preparePublication(move.sourcePath, move, live);
    try {
      await renameWorkspaceFolder(move.sourcePath, move.destinationPath, this.deps);
    } catch (error) {
      if (moveErrorCode(error) !== "EXDEV") throw error;
      live.crossDrive = true;
      await this.copyFolder(move, live);
      return;
    }
    await this.save(move, { phase: "renamed" });
  }

  private async preparePublication(source: string, move: WorkspaceMove, live: LiveMove): Promise<void> {
    await assertRecordedParent(move.destinationPath);
    const claimDestination = this.deps.claimDestination ?? NodeFSPromises.mkdir;
    await claimDestination(move.destinationPath);
    live.claimedDestination = true;
    await writeMoveMarker(move.destinationPath, move.id);
    if (this.deps.platform === "win32") {
      await removeMoveClaim(move.destinationPath, move.id);
      live.claimedDestination = false;
    } else {
      await removeMoveMarker(move.destinationPath, move.id);
    }
    await assertRecordedParent(move.destinationPath);
    if (!holdsMoveMarker(await inspectMoveFolder(source, move.id))) throw new Error("The folder to publish lost its move marker");
  }

  private async copyFolder(move: WorkspaceMove, live: LiveMove): Promise<void> {
    if (live.claimedDestination) {
      await removeMoveClaim(move.destinationPath, move.id);
      live.claimedDestination = false;
    }
    const staging = NodePath.join(NodePath.dirname(move.destinationPath), `.mcode-copy-${move.id}`);
    move = await this.save(move, { stagingPath: staging, claimReleased: true }, undefined, false);
    await assertRecordedParent(staging);
    await NodeFSPromises.mkdir(staging);
    live.createdStaging = true;
    move = await this.save(move, { phase: "copying" }, undefined, false);
    let lastProgress = Number.NEGATIVE_INFINITY;
    const manifest = await copyWorkspaceFolder({
      source: move.sourcePath, staging, moveId: move.id, platform: this.deps.platform,
      openDestination: this.deps.openCopyDestination,
      progress: async (copiedBytes, totalBytes) => {
        const now = Date.parse(this.now());
        if (now - lastProgress < 100) return;
        lastProgress = now;
        move = await this.save(move, { phase: "copying", copiedBytes, totalBytes });
      },
    });
    move = await this.save(move, { phase: "copied", manifest });
    await this.preparePublication(staging, move, live);
    await renameWorkspaceFolder(staging, move.destinationPath, this.deps);
    await this.save(move, { phase: "published" });
  }

  private async recover(move: WorkspaceMove): Promise<void> {
    if (move.phase === "converted") {
      await this.finishConverted(move, []);
      return;
    }
    if (move.phase === "done") {
      if (move.cleanup === "pending" && move.result?.status === "failed") await this.cleanRolledBackMarker(move);
      return;
    }
    await this.rollback(move, interruptedMoveFailure(move));
  }

  private async rollback(move: WorkspaceMove, failure: MoveFailure, live?: LiveMove): Promise<void> {
    const marker: { path: string | null } = { path: null };
    const crossDrive = move.stagingPath !== null || live?.crossDrive === true;
    let partialCopyRemoved = true;
    try {
      partialCopyRemoved = await this.rollbackFolders(move, marker, live);
      if (!partialCopyRemoved) {
        failure = { ...failure, error: `${failure.error}\nThe staging path is occupied by an unmarked entry: ${move.stagingPath}` };
      }
    } catch (error) {
      if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
      const detail = `${failure.error}\nRollback: ${moveError(error)}`;
      await this.save(move, {
        cleanup: "kept", error: failure.error,
        result: {
          status: "rollback-pending", ...failure, error: detail, markerPath: marker.path,
          ...(crossDrive ? { partialCopyRemoved: false } : {}),
        },
      });
      return;
    }
    const failed = await this.save(move, {
      phase: "done", cleanup: "pending", error: failure.error,
      result: { status: "failed", ...failure, ...(crossDrive ? { partialCopyRemoved } : {}) },
    });
    await this.cleanRolledBackMarker(failed);
  }

  private async rollbackFolders(move: WorkspaceMove, marker: { path: string | null }, live?: LiveMove): Promise<boolean> {
    const source = await inspectMoveFolder(move.sourcePath, move.id);
    if (holdsMoveMarker(source)) marker.path = markerPath(move.sourcePath, move.id);
    const destination = await inspectMoveFolder(move.destinationPath, move.id);
    if (marker.path === null && holdsMoveMarker(destination)) marker.path = markerPath(move.destinationPath, move.id);
    const { stagingPath } = move;
    if (stagingPath === null) {
      await this.rollbackRename(move, source, destination, live?.claimedDestination ?? true);
      return true;
    }
    const staging = await inspectMoveFolder(stagingPath, move.id);
    if (marker.path === null && holdsMoveMarker(staging)) marker.path = markerPath(stagingPath, move.id);
    return rollbackCopy({ move, stagingPath, source, staging, destination, live });
  }

  private async rollbackRename(move: WorkspaceMove, source: MoveFolderState, destination: MoveFolderState, removeClaim: boolean): Promise<void> {
    const action = rollbackActions[source]?.[destination];
    if (!action) throw new Error("The recorded folder paths do not identify a safe rollback");
    if (action === "rename-back") {
      await assertRecordedParent(move.sourcePath);
      await assertRecordedParent(move.destinationPath);
      await renameWorkspaceFolder(move.destinationPath, move.sourcePath, this.deps);
    }
    if (action === "remove-claim" && removeClaim) await removeMoveClaim(move.destinationPath, move.id);
  }

  private async cleanRolledBackMarker(move: WorkspaceMove): Promise<void> {
    await removeMoveMarker(move.sourcePath, move.id);
    await this.save(move, { cleanup: "done" }, undefined, false);
  }

  private async finishConverted(move: WorkspaceMove, sharers: ReturnType<WorkspaceMoveStore["convert"]>): Promise<void> {
    if (!move.result) {
      const state = await inspectMoveFolder(move.destinationPath, move.id);
      if (!holdsMoveMarker(state)) throw new Error("The converted project does not hold its move marker");
      const { result, git } = move.initGit
        ? await this.initializeGit(move)
        : { result: { status: "created" as const, workspaceId: move.workspaceId }, git: undefined };
      move = await this.save(move, {
        phase: "converted", result, cleanup: "done", error: result.status === "git-failed" ? result.error : null,
      }, git);
    }
    // The Git outcome must be durable before removing the only proof of the rename.
    await removeMoveMarker(move.destinationPath, move.id);
    const retainedSource = move.stagingPath
      ? { cleanup: "pending" as const, sourceRetainUntil: noProjectRetentionDeadline(this.now()) }
      : {};
    await this.save(move, { phase: "done", ...retainedSource });
    this.publishProject(move, sharers);
  }

  private async initializeGit(move: WorkspaceMove): Promise<{
    result: Extract<WorkspaceMoveRetryGitResult, { status: "created" | "git-failed" }>; git?: Placement;
  }> {
    try {
      await assertRecordedParent(move.destinationPath);
      if (!(await NodeFSPromises.lstat(move.destinationPath)).isDirectory()) throw new Error("The project folder no longer exists");
      let git = await this.gitPlacement(move.destinationPath);
      if (!git) {
        await this.deps.git.exec(["-C", move.destinationPath, "init"]);
        git = await this.gitPlacement(move.destinationPath);
        if (!git) throw new Error("Git init did not create a repository in the project folder");
      }
      return { result: { status: "created", workspaceId: move.workspaceId }, git };
    } catch (error) {
      return { result: { status: "git-failed", workspaceId: move.workspaceId, error: moveError(error) } };
    }
  }

  private async gitPlacement(path: string): Promise<Placement | null> {
    try {
      const root = await this.deps.git.exec(["-C", path, "rev-parse", "--show-toplevel"]);
      if (NodePath.relative(path, await NodeFSPromises.realpath(root.stdout.trim())) !== "") return null;
    } catch {
      return null;
    }
    // symbolic-ref also names the initial branch before the first commit.
    const branch = await this.deps.git.exec(["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
    return { isGitRepo: true, branch: branch?.stdout.trim() || "HEAD" };
  }

  private async save(move: WorkspaceMove, next: Receipt, git?: Placement, publish = true): Promise<WorkspaceMove> {
    await this.deps.writer.execute(workspaceMoveWrites.advance, [move.id, move.revision, next, this.now(), git]);
    const updated = this.requireMove(move.id);
    if (publish) this.deps.publishProgress(moveFrame(updated));
    return updated;
  }

  private async failure(error: unknown, destination: string): Promise<MoveFailure> {
    return { error: moveError(error), cause: await moveFailureCause(error, destination, this.deps.platform) };
  }

  private requireMove(id: string): WorkspaceMove {
    const move = this.deps.store.find(id);
    if (!move) throw new Error(`Workspace move receipt is missing: ${id}`);
    return move;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private publishProject(move: WorkspaceMove, sharers: ReturnType<WorkspaceMoveStore["convert"]>): void {
    const workspace = this.deps.workspaces.findById(move.workspaceId);
    if (workspace) this.deps.publishConverted(workspace, sharers.map(({ thread, marker }) => ({
      thread: this.deps.threads.findById(thread.id) ?? thread, marker,
    })));
  }

  private logFailure(move: WorkspaceMove, error: unknown): void {
    logger.warn("Workspace move needs recovery", { operationId: move.id, workspaceId: move.workspaceId, error: moveError(error) });
  }
}
