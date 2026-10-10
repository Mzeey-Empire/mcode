/**
 * Durable Review commits. Each click is a stored request, so a repeated click, a lost response
 * or a restart returns the stored outcome instead of making a second commit. Only the process
 * that saw `git commit` exit may store `committed`, and only `committed` requests push.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type { GitCommitFile, GitCommitRejection, GitCommitResult } from "@mcode/contracts";
import { gitExitCode, gitFailureOutput, gitWasKilled } from "../execution/git-failure.js";
import type { GitExecutor } from "../execution/types.js";
import { GitPushService } from "../git-push-service.js";
import { batchLiteralPaths, isLiteralRepoPath } from "../literal-paths.js";
import { RepositoryGitMutationLock } from "../repository-git-mutation-lock.js";
import {
  hashCommitRequestInputs,
  toCommitResult,
  type CommitPushDestination,
  type CommitRequestRecord,
  type CommitSettlement,
  type CommittedCommitRequest,
  type FinishedCommitPush,
  type PreparedCommitRequest,
} from "./commit-request.js";
import {
  COMMIT_TIMEOUT_SECONDS,
  reconcilePrepared,
  settleCommit,
  type CommitAttemptSettlement,
  type CommitExit,
} from "./commit-settlement.js";
import { GitCommitRequestRepo } from "./persistence/git-commit-request-repo.js";

/** Requests are kept this long for replays, then deleted at startup. */
export const COMMIT_REQUEST_RETENTION_DAYS = 30;

/** Test-only points where a commit request stops as if the server died there. */
export type GitCommitFaultPoint = "after-prepared-write" | "after-commit-exit" | "before-push";

/** Thrown at a fault point. The service never catches it, so the request is left exactly as a crash would leave it. */
export class GitCommitFaultStop extends Error {
  constructor(readonly point: GitCommitFaultPoint) {
    super(`Commit request stopped at ${point}`);
    this.name = "GitCommitFaultStop";
  }
}

/** Test-only controls for one commit request. */
export interface GitCommitOptions {
  readonly stopAt?: GitCommitFaultPoint;
}

/** One commit click, with the checkout already resolved by the strict resolver. */
export interface GitCommitRequest {
  requestId: string;
  workspaceId: string;
  threadId: string | null;
  repoPath: string;
  expectedHead: string | null;
  files: readonly GitCommitFile[];
  message: string;
  push: boolean;
}

type SettledCommitRequest = Exclude<CommitRequestRecord, PreparedCommitRequest>;

type LockedOutcome =
  | { kind: "settled"; record: SettledCommitRequest }
  | { kind: "replay"; record: CommitRequestRecord }
  | { kind: "precondition"; rejection: GitCommitRejection };

interface CommitAttempt {
  exit: CommitExit;
  /** Untracked paths this attempt added with intent-to-add; rolled back when nothing was committed. */
  intentToAdd: readonly string[];
}

/** Commits the selected Review files and pushes the commit it made. */
@injectable()
export class GitCommitService {
  private readonly runningPushes = new Map<string, Promise<SettledCommitRequest>>();

  constructor(
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(RepositoryGitMutationLock) private readonly lock: Pick<RepositoryGitMutationLock, "run">,
    @inject(GitCommitRequestRepo) private readonly requests: Pick<
      GitCommitRequestRepo,
      "findById" | "listPrepared" | "insertPrepared" | "settle" | "recordPush" | "deleteExpired"
    >,
    @inject(GitPushService) private readonly pushes: Pick<GitPushService, "captureDestination" | "pushCommit">,
  ) {}

  /** Commit once per requestId. A replay with the same inputs returns the stored outcome. */
  async commit(request: GitCommitRequest, options: GitCommitOptions = {}): Promise<GitCommitResult> {
    const pathspecs = commitPathspecs(request.files);
    const inputsHash = hashCommitRequestInputs(request);
    const stored = this.requests.findById(request.requestId);
    if (stored) return this.replay(stored, inputsHash);
    const outcome = await this.lock.run(
      request.repoPath,
      () => this.commitUnderLock(request, pathspecs, inputsHash, options),
    );
    switch (outcome.kind) {
      case "precondition":
        return { status: "rejected", reason: outcome.rejection };
      case "replay":
        return this.replay(outcome.record, inputsHash);
      case "settled":
        return toCommitResult(await this.pushIfPending(outcome.record, options));
    }
  }

  /** Settle every request a previous process left `prepared`. Run before accepting RPCs. */
  async reconcileAllPrepared(): Promise<void> {
    for (const record of this.requests.listPrepared()) {
      if (record.state === "prepared") await this.reconcile(record);
    }
  }

  /** Delete requests older than the retention window. */
  deleteExpired(): Promise<number> {
    return this.requests.deleteExpired(COMMIT_REQUEST_RETENTION_DAYS);
  }

  private async replay(record: CommitRequestRecord, inputsHash: string): Promise<GitCommitResult> {
    if (record.inputsHash !== inputsHash) {
      throw new Error("This commit request id was already used with different inputs.");
    }
    const settled = record.state === "prepared" ? await this.reconcile(record) : record;
    // The request that owns a running push reports its outcome; a concurrent replay reports pending.
    if (this.runningPushes.has(settled.requestId)) return toCommitResult(settled);
    return toCommitResult(await this.pushIfPending(settled, {}));
  }

  private async commitUnderLock(
    request: GitCommitRequest,
    pathspecs: readonly string[],
    inputsHash: string,
    options: GitCommitOptions,
  ): Promise<LockedOutcome> {
    // A concurrent click with this requestId may have committed while this one waited for the lock.
    const raced = this.requests.findById(request.requestId);
    if (raced) return { kind: "replay", record: raced };
    const originalHead = await this.readHead(request.repoPath);
    if (originalHead !== request.expectedHead) {
      return { kind: "precondition", rejection: { kind: "head-moved", head: originalHead } };
    }
    const branch = await this.readBranch(request.repoPath);
    if (request.push && branch === null) return { kind: "precondition", rejection: { kind: "no-branch" } };
    const destination = request.push && branch !== null
      ? this.pushes.captureDestination(request.workspaceId, request.threadId, branch)
      : null;
    await this.requests.insertPrepared({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      repoPath: request.repoPath,
      inputsHash,
      originalHead,
      branch,
      destination,
    });
    stopAt(options, "after-prepared-write");
    const attempt = await this.runCommit(request.repoPath, pathspecs, request.message);
    stopAt(options, "after-commit-exit");
    return { kind: "settled", record: await this.settleAttempt(request, originalHead, destination, attempt) };
  }

  private async settleAttempt(
    request: GitCommitRequest,
    originalHead: string | null,
    destination: CommitPushDestination | null,
    attempt: CommitAttempt,
  ): Promise<SettledCommitRequest> {
    const currentHead = await this.readHead(request.repoPath);
    const settlement = settleCommit({
      exit: attempt.exit,
      originalHead,
      currentHead,
      currentHeadFirstParent: currentHead === null ? null : await this.readFirstParent(request.repoPath),
    });
    await this.requests.settle(request.requestId, toStoredSettlement(settlement, destination));
    // The outcome is stored first, so a failed rollback cannot erase why the commit was rejected.
    if (settlement.state === "rejected") await this.removeIntentToAdd(request.repoPath, attempt.intentToAdd);
    return this.requireSettled(request.requestId);
  }

  private async runCommit(repoPath: string, pathspecs: readonly string[], message: string): Promise<CommitAttempt> {
    const gitDir = NodePath.resolve(repoPath, (await this.gitExecutor.exec(["-C", repoPath, "rev-parse", "--git-dir"])).stdout.trim());
    const base = NodePath.join(gitDir, `mcode-commit-${NodeCrypto.randomUUID()}`);
    const files = { pathspecs: base, intentToAdd: `${base}.add`, message: `${base}.msg` };
    try {
      const intentToAdd = await this.untrackedAmong(repoPath, pathspecs);
      if (intentToAdd.length > 0) {
        await NodeFSPromises.writeFile(files.intentToAdd, intentToAdd.join("\0"));
        const added = await this.runGitStep(
          ["--literal-pathspecs", "-C", repoPath, "add", "-N", `--pathspec-from-file=${files.intentToAdd}`, "--pathspec-file-nul"],
          30_000,
        );
        if (!(added.kind === "exited" && added.code === 0)) return { exit: added, intentToAdd: [] };
      }
      await NodeFSPromises.writeFile(files.pathspecs, pathspecs.join("\0"));
      await NodeFSPromises.writeFile(files.message, message);
      const exit = await this.runGitStep([
        "--literal-pathspecs", "-C", repoPath, "-c", "core.quotePath=false", "commit",
        `--pathspec-from-file=${files.pathspecs}`, "--pathspec-file-nul", "-F", files.message,
      ], COMMIT_TIMEOUT_SECONDS * 1000);
      return { exit, intentToAdd };
    } finally {
      await Promise.all(Object.values(files).map(removeIfPresent));
    }
  }

  private async runGitStep(args: string[], timeout: number): Promise<CommitExit> {
    try {
      const { stdout, stderr } = await this.gitExecutor.exec(args, { timeout });
      return { kind: "exited", code: 0, output: `${stdout}\n${stderr}`.trim() };
    } catch (error) {
      if (gitWasKilled(error)) return { kind: "killed", output: gitFailureOutput(error) };
      const code = gitExitCode(error);
      if (code === null) throw error;
      return { kind: "exited", code, output: gitFailureOutput(error) };
    }
  }

  private async untrackedAmong(repoPath: string, pathspecs: readonly string[]): Promise<string[]> {
    const { stdout } = await this.gitExecutor.exec(
      ["-C", repoPath, "ls-files", "--others", "--exclude-standard", "-z"],
      { timeout: 30_000 },
    );
    const untracked = new Set(stdout.split("\0").filter(Boolean));
    return pathspecs.filter((path) => untracked.has(path));
  }

  private async removeIntentToAdd(repoPath: string, paths: readonly string[]): Promise<void> {
    for (const batch of batchLiteralPaths(paths)) {
      await this.gitExecutor.exec(
        ["--literal-pathspecs", "-C", repoPath, "rm", "--cached", "-q", "--ignore-unmatch", "--", ...batch],
        { timeout: 30_000 },
      );
    }
  }

  private async pushIfPending(record: SettledCommitRequest, options: GitCommitOptions): Promise<SettledCommitRequest> {
    if (record.state !== "committed" || record.push.state !== "pending") return record;
    stopAt(options, "before-push");
    const { destination } = record.push;
    const running = this.runningPushes.get(record.requestId);
    if (running) return running;
    const push = this.pushAndRecord(record, destination)
      .finally(() => this.runningPushes.delete(record.requestId));
    this.runningPushes.set(record.requestId, push);
    return push;
  }

  private async pushAndRecord(
    record: CommittedCommitRequest,
    destination: CommitPushDestination,
  ): Promise<SettledCommitRequest> {
    await this.requests.recordPush(record.requestId, await this.pushCommit(record, destination));
    return this.requireSettled(record.requestId);
  }

  private async pushCommit(
    record: CommittedCommitRequest,
    destination: CommitPushDestination,
  ): Promise<FinishedCommitPush> {
    try {
      await this.pushes.pushCommit({
        workspaceId: record.workspaceId,
        repoPath: record.repoPath,
        sha: record.commitSha,
        destination,
      });
      return { state: "pushed", destination };
    } catch (error) {
      // A failed push never undoes the commit. It is the result the user sees, so it is stored, not thrown.
      const detail = gitFailureOutput(error);
      logger.warn("Commit request push failed", { requestId: record.requestId, detail });
      return { state: "failed", destination, failure: { summary: firstLine(detail) ?? "Push failed", detail } };
    }
  }

  private reconcile(record: PreparedCommitRequest): Promise<SettledCommitRequest> {
    return this.lock.run(record.repoPath, async () => {
      // The original request may have settled the row while this caller waited for the lock.
      const current = this.requests.findById(record.requestId);
      if (current && current.state !== "prepared") return current;
      await this.requests.settle(record.requestId, await this.observeOrphan(record));
      return this.requireSettled(record.requestId);
    });
  }

  private async observeOrphan(record: PreparedCommitRequest): Promise<CommitSettlement> {
    try {
      return reconcilePrepared({
        originalHead: record.originalHead,
        currentHead: await this.readHead(record.repoPath),
        indexLockPresent: await this.indexLockPresent(record.repoPath),
      });
    } catch (error) {
      if (gitExitCode(error) === null) throw error;
      return {
        state: "unknown",
        head: null,
        detail: `Mcode stopped before it recorded the outcome, and the checkout can no longer be read.\n${gitFailureOutput(error)}`,
      };
    }
  }

  private async indexLockPresent(repoPath: string): Promise<boolean> {
    const { stdout } = await this.gitExecutor.exec(["-C", repoPath, "rev-parse", "--git-path", "index.lock"]);
    return NodeFSPromises.lstat(NodePath.resolve(repoPath, stdout.trim())).then(() => true, (error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    });
  }

  private readHead(repoPath: string): Promise<string | null> {
    return this.readOptional(["-C", repoPath, "rev-parse", "--verify", "-q", "HEAD"]);
  }

  private readFirstParent(repoPath: string): Promise<string | null> {
    return this.readOptional(["-C", repoPath, "rev-parse", "--verify", "-q", "HEAD^1"]);
  }

  private readBranch(repoPath: string): Promise<string | null> {
    return this.readOptional(["-C", repoPath, "symbolic-ref", "--short", "-q", "HEAD"]);
  }

  /** Run a quiet probe. Exit 1 means "not there" (unborn HEAD, root commit, detached HEAD); anything else throws. */
  private async readOptional(args: string[]): Promise<string | null> {
    try {
      const value = (await this.gitExecutor.exec(args)).stdout.trim();
      return value.length > 0 ? value : null;
    } catch (error) {
      if (gitExitCode(error) === 1) return null;
      throw error;
    }
  }

  private requireSettled(requestId: string): SettledCommitRequest {
    const record = this.requests.findById(requestId);
    if (!record || record.state === "prepared") throw new Error(`Commit request ${requestId} was not settled.`);
    return record;
  }
}

/**
 * The literal pathspecs a request commits: each path and, for renames, its previous path, so the
 * old side's deletion is committed too. An unsafe path is a validation error and stores nothing.
 */
export function commitPathspecs(files: readonly GitCommitFile[]): string[] {
  const paths = files.flatMap((file) => file.previousPath === null ? [file.path] : [file.path, file.previousPath]);
  const invalid = paths.find((path) => !isLiteralRepoPath(path));
  if (invalid !== undefined) throw new Error(`Invalid repository path: ${invalid}`);
  return [...new Set(paths.map((path) => path.replaceAll("\\", "/")))];
}

function toStoredSettlement(
  settlement: CommitAttemptSettlement,
  destination: CommitPushDestination | null,
): CommitSettlement {
  if (settlement.state !== "committed") return settlement;
  return {
    state: "committed",
    commitSha: settlement.commitSha,
    push: destination ? { state: "pending", destination } : { state: "skipped" },
  };
}

function stopAt(options: GitCommitOptions, point: GitCommitFaultPoint): void {
  if (options.stopAt === point) throw new GitCommitFaultStop(point);
}

function firstLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
}

async function removeIfPresent(path: string): Promise<void> {
  await NodeFSPromises.unlink(path).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
