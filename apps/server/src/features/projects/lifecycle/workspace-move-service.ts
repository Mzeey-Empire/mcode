import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  CreateProjectFromFolderInput, CreateProjectFromFolderResult, WorkspaceMoveFrame,
  WorkspaceMoveRetryGitResult, WorkspaceMoveStatusInput,
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
import {
  assertRecordedParent, inspectMoveFolder, markerPath, moveError, removeMoveClaim, removeMoveMarker,
  resolveWorkspaceMovePaths, writeMoveMarker, type MoveFolderState,
} from "./workspace-move-files.js";
import { acquireWorkspaceMoveGate, isInsideMoveSource } from "./workspace-move-gate.js";

type Placement = Parameters<WorkspaceMoveStore["convert"]>[1];
type Receipt = Pick<WorkspaceMove, "phase" | "result" | "cleanup" | "error">;
type RollbackAction = "rename-back" | "remove-claim" | "finish";

// Intent and renamed use the same observations because the phase write can lag the rename.
const rollbackActions: Partial<Record<MoveFolderState, Partial<Record<MoveFolderState, RollbackAction>>>> = {
  missing: { "marker-only": "rename-back", owned: "rename-back" },
  empty: { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
  "marker-only": { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
  owned: { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
  foreign: { missing: "finish", empty: "remove-claim", "marker-only": "remove-claim", foreign: "finish", other: "finish" },
};

function holdsMarker(state: MoveFolderState): boolean {
  return state === "marker-only" || state === "owned";
}

function moveFrame(move: WorkspaceMove): WorkspaceMoveFrame {
  const result = move.phase === "done" || move.result?.status === "rollback-pending" ? move.result : null;
  return {
    operationId: move.id, revision: move.revision, phase: move.phase, copiedBytes: null, totalBytes: null,
    ...(result ? { result } : {}),
  };
}

type MoveDeps = {
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
  platform: NodeJS.Platform;
  claimDestination?: (path: string) => Promise<void>;
  publishProgress(frame: WorkspaceMoveFrame): void;
  publishConverted(workspace: Workspace, sharers: ReturnType<WorkspaceMoveStore["convert"]>): void;
  now?: () => Date;
};

/** Convert a managed workspace with a recoverable protocol around its filesystem rename. */
export class WorkspaceMoveService {
  private readonly root: string;

  constructor(mcodeDir: string, private readonly deps: MoveDeps) {
    this.root = NodePath.join(mcodeDir, "no-project");
  }

  /** Reserve all sharers and return a durable operation before changing the disk. */
  async createProject(input: CreateProjectFromFolderInput): Promise<CreateProjectFromFolderResult> {
    const thread = this.deps.threads.findById(input.threadId);
    const workspace = thread && this.deps.workspaces.findById(thread.workspace_id);
    if (!workspace || workspace.kind !== "no_project") return { status: "failed", error: "The thread has no managed No project folder" };
    const releaseGate = acquireWorkspaceMoveGate(workspace.id, workspace.path);
    if (!releaseGate) return { status: "failed", error: "The workspace is already being changed" };
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
      await this.closeFolderUsers(workspace.id, paths.sourcePath, reservations);
      const id = NodeCrypto.randomUUID();
      await this.deps.writer.execute(workspaceMoveWrites.start, [{
        id, workspaceId: workspace.id, name: input.name, initGit: input.initGit, createdAt: this.now(), ...paths,
      }, [...reservations.keys()]]);
      const move = this.requireMove(id);
      this.deps.publishProgress(moveFrame(move));
      setImmediate(() => {
        void this.run(move).catch((error: unknown) => this.logFailure(move, error)).finally(release);
      });
      scheduled = true;
      return { operationId: id };
    } catch (error) {
      return { status: "failed", error: moveError(error) };
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
      await this.save(move, { phase: "done", cleanup: "done", result, error: result.status === "git-failed" ? result.error : null }, git, false);
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

  private async run(intent: WorkspaceMove): Promise<void> {
    let claimed = false;
    let converted: ReturnType<WorkspaceMoveStore["convert"]>;
    try {
      await writeMoveMarker(intent.sourcePath, intent.id);
      await assertRecordedParent(intent.destinationPath);
      const claimDestination = this.deps.claimDestination ?? NodeFSPromises.mkdir;
      await claimDestination(intent.destinationPath);
      claimed = true;
      await writeMoveMarker(intent.destinationPath, intent.id);
      if (this.deps.platform === "win32") await removeMoveClaim(intent.destinationPath, intent.id);
      else await removeMoveMarker(intent.destinationPath, intent.id);
      await assertRecordedParent(intent.destinationPath);
      if (!holdsMarker(await inspectMoveFolder(intent.sourcePath, intent.id))) {
        throw new Error("The source folder no longer holds the move marker");
      }
      await NodeFSPromises.rename(intent.sourcePath, intent.destinationPath);
      await this.save(intent, { phase: "renamed", cleanup: "done", result: null, error: null });
      const git = await this.gitPlacement(intent.destinationPath);
      converted = await this.deps.writer.execute(workspaceMoveWrites.convert, [intent.id, git ?? { isGitRepo: false, branch: "main" }, this.now()]);
    } catch (error) {
      // An unknown commit outcome may still succeed on the writer. Only startup can safely decide.
      if (error instanceof DatabaseWriteOutcomeUnknown) throw error;
      await this.rollback(this.requireMove(intent.id), moveError(error), claimed);
      return;
    }
    const move = this.requireMove(intent.id);
    this.deps.publishProgress(moveFrame(move));
    await this.finishConverted(move, converted);
  }

  private async recover(move: WorkspaceMove): Promise<void> {
    switch (move.phase) {
      case "intent":
      case "renamed":
        await this.rollback(move, move.error ?? "The server stopped before the folder move committed", true);
        break;
      case "converted":
        await this.finishConverted(move, []);
        break;
      case "done":
        if (move.cleanup === "pending" && move.result?.status === "failed") await this.cleanRolledBackMarker(move);
        break;
    }
  }

  private async rollback(move: WorkspaceMove, cause: string, removeClaim: boolean): Promise<void> {
    let ownedPath: string | null = null;
    try {
      const source = await inspectMoveFolder(move.sourcePath, move.id);
      if (holdsMarker(source)) ownedPath = markerPath(move.sourcePath, move.id);
      const destination = await inspectMoveFolder(move.destinationPath, move.id);
      if (holdsMarker(destination) && ownedPath === null) ownedPath = markerPath(move.destinationPath, move.id);
      const action = rollbackActions[source]?.[destination];
      if (!action) throw new Error("The recorded folder paths do not identify a safe rollback");
      if (action === "rename-back") {
        await assertRecordedParent(move.sourcePath);
        await assertRecordedParent(move.destinationPath);
        await NodeFSPromises.rename(move.destinationPath, move.sourcePath);
      }
      if (action === "remove-claim" && removeClaim) await removeMoveClaim(move.destinationPath, move.id);
    } catch (error) {
      const detail = `${cause}\nRollback: ${moveError(error)}`;
      await this.save(move, {
        phase: move.phase, cleanup: "kept", error: cause,
        result: { status: "rollback-pending", error: detail, markerPath: ownedPath },
      });
      return;
    }
    const failed = await this.save(move, {
      phase: "done", cleanup: "pending", error: cause, result: { status: "failed", error: cause },
    });
    await this.cleanRolledBackMarker(failed);
  }

  private async cleanRolledBackMarker(move: WorkspaceMove): Promise<void> {
    await removeMoveMarker(move.sourcePath, move.id);
    await this.save(move, { ...move, cleanup: "done" }, undefined, false);
  }

  private async finishConverted(move: WorkspaceMove, sharers: ReturnType<WorkspaceMoveStore["convert"]>): Promise<void> {
    if (!move.result) {
      const state = await inspectMoveFolder(move.destinationPath, move.id);
      if (!holdsMarker(state)) throw new Error("The converted project does not hold its move marker");
      const { result, git } = move.initGit
        ? await this.initializeGit(move)
        : { result: { status: "created" as const, workspaceId: move.workspaceId }, git: undefined };
      move = await this.save(move, {
        phase: "converted", result, cleanup: "done", error: result.status === "git-failed" ? result.error : null,
      }, git);
    }
    // The Git outcome must be durable before removing the only proof of the rename.
    await removeMoveMarker(move.destinationPath, move.id);
    await this.save(move, { ...move, phase: "done" });
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
    const { phase, cleanup, result, error } = next;
    await this.deps.writer.execute(workspaceMoveWrites.advance, [
      move.id, move.revision, { phase, cleanup, result, error }, this.now(), git,
    ]);
    const updated = this.requireMove(move.id);
    if (publish) this.deps.publishProgress(moveFrame(updated));
    return updated;
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
