/** Git refs that keep turn snapshot trees reachable, so `git gc` cannot prune them. */

import type { Database } from "bun:sqlite";
import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import {
  canonicalAgentIngestCheckpoints,
  messages,
  storeIdentity,
  threads,
  turnSnapshots,
  workspaces,
} from "../../../../runtime/persistence/sqlite/schema.js";
import { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { persistInterruptedAttemptSnapshot } from "../../../agents/turns/persistence/turn-finalization-write-operations.js";
import type { GitExecutor } from "../../git/execution/index.js";
import { RealGitExecutor } from "../../git/execution/real-git-executor.js";
import { RepositoryGitMutationLock } from "../../git/repository-git-mutation-lock.js";
import { normalizePathForComparison } from "../../../../shared/filesystem/path-identity.js";
import { SnapshotService } from "./snapshot-service.js";
import { SNAPSHOT_STORE_ID, type StoreId } from "./snapshot-store-identity.js";

/** Pin of a turn's pre-turn tree while the turn has no snapshot row yet. */
export type BaselinePin =
  | { readonly kind: "baseline"; readonly threadId: string; readonly executionId: string }
  | { readonly kind: "baseline-tree"; readonly threadId: string; readonly tree: string };

/** Every ref shape this module owns inside one store namespace. */
export type PinRef = { readonly kind: "snapshot"; readonly snapshotId: string } | BaselinePin;

/** The two points where the test-only fault hook stops an interrupted-attempt write. */
export type SnapshotPinFaultPoint = "before-row-write" | "after-row-write";

/** Thrown by the test-only fault hook to simulate a crash. Pin error handling never catches it. */
export class SnapshotPinFaultStop extends Error {
  constructor(readonly point: SnapshotPinFaultPoint) {
    super(`Snapshot pin fault hook stopped at ${point}`);
    this.name = "SnapshotPinFaultStop";
  }
}

/** Options for one settle or sweep pass. */
export interface SnapshotPinPassOptions {
  /** True while the server runtime holds a turn for the thread. Read at decision time. */
  readonly isThreadLive?: (threadId: string) => boolean;
  /** Test-only crash point inside an interrupted-attempt write. */
  readonly stopAt?: SnapshotPinFaultPoint;
}

/** The trees a snapshot row compares, keyed by the row id that names its pin. */
export interface PinnableSnapshot {
  readonly id: string;
  readonly refBefore: string;
  readonly refAfter: string;
}

const REF_ROOT = "refs/mcode";
// Dots are excluded so no component can end in `.lock` or form `..`.
const REF_COMPONENT = /^[A-Za-z0-9_-]{1,128}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PIN_COMMIT_MESSAGE = "mcode snapshot pin";
/** Fixed identity so pinning works in repositories with no `user.email`. */
const PIN_COMMIT_ENV = {
  GIT_AUTHOR_NAME: "Mcode",
  GIT_AUTHOR_EMAIL: "mcode@localhost",
  GIT_COMMITTER_NAME: "Mcode",
  GIT_COMMITTER_EMAIL: "mcode@localhost",
} as const;

function requireComponent(value: string, label: string): string {
  if (!REF_COMPONENT.test(value)) throw new Error(`Snapshot pin ${label} is not a safe ref component`);
  return value;
}

function requireObjectId(value: string, label: string): string {
  if (!OBJECT_ID.test(value)) throw new Error(`Snapshot pin ${label} is not a Git object id`);
  return value;
}

/** The namespace prefix one store lists and deletes inside. */
export function storeRefPrefix(storeId: StoreId): string {
  return `${REF_ROOT}/${storeId}/`;
}

/** Format the full ref name of one pin. Throws on a component that is unsafe in a ref name. */
export function formatPinRef(storeId: StoreId, pin: PinRef): string {
  const prefix = storeRefPrefix(storeId);
  switch (pin.kind) {
    case "snapshot":
      return `${prefix}snapshots/${requireComponent(pin.snapshotId, "snapshot id")}`;
    case "baseline":
      return `${prefix}baselines/${requireComponent(pin.threadId, "thread id")}/${requireComponent(pin.executionId, "execution id")}`;
    case "baseline-tree":
      return `${prefix}baseline-trees/${requireComponent(pin.threadId, "thread id")}/${requireObjectId(pin.tree, "tree")}`;
  }
}

/** Parse a ref this store owns. Returns null for any ref outside this store's pin shapes. */
export function parsePinRef(storeId: StoreId, ref: string): PinRef | null {
  const prefix = storeRefPrefix(storeId);
  if (!ref.startsWith(prefix)) return null;
  const parts = ref.slice(prefix.length).split("/");
  if (parts.length === 2) return parseSnapshotPin(parts);
  if (parts.length === 3) return parseBaselinePin(parts);
  return null;
}

function parseSnapshotPin([kind, snapshotId]: string[]): PinRef | null {
  if (kind !== "snapshots" || !snapshotId || !REF_COMPONENT.test(snapshotId)) return null;
  return { kind: "snapshot", snapshotId };
}

function parseBaselinePin([kind, threadId, last]: string[]): BaselinePin | null {
  if (!threadId || !last || !REF_COMPONENT.test(threadId)) return null;
  if (kind === "baselines" && REF_COMPONENT.test(last)) return { kind: "baseline", threadId, executionId: last };
  if (kind === "baseline-trees" && OBJECT_ID.test(last)) return { kind: "baseline-tree", threadId, tree: last };
  return null;
}

/** Name a turn's baseline pin by its execution, or by its tree when no execution was admitted. */
export function baselinePinFor(threadId: string, executionId: string | undefined, tree: string): BaselinePin {
  return executionId
    ? { kind: "baseline", threadId, executionId }
    : { kind: "baseline-tree", threadId, tree };
}

interface ListedPin {
  readonly ref: string;
  readonly pin: PinRef;
  readonly commit: string;
  readonly tree: string;
}

type ListedBaseline = ListedPin & { readonly pin: Extract<PinRef, { kind: "baseline" }> };

function isListedBaseline(listed: ListedPin): listed is ListedBaseline {
  return listed.pin.kind === "baseline";
}

interface SweepRepository {
  readonly cwd: string;
  readonly workspaceIds: ReadonlySet<string>;
}

/** Owns pin refs for the snapshot rows of the database this process opened. */
@injectable()
export class SnapshotRefPins {
  private readonly orm: BunSQLiteDatabase;
  private readonly background = new Set<Promise<void>>();

  constructor(
    @inject("GitExecutor") private readonly git: GitExecutor,
    @inject(SNAPSHOT_STORE_ID) private readonly storeId: StoreId,
    @inject("Database") db: Database,
    @inject(ApplicationDatabaseWriter) private readonly writer: Pick<ApplicationDatabaseWriter, "execute">,
    @inject(RepositoryGitMutationLock) private readonly lock: RepositoryGitMutationLock,
    @inject(SnapshotService) private readonly snapshots: SnapshotService,
    @inject("HostRuntime") private readonly hostRuntime: Pick<HostRuntime, "platform">,
  ) {
    this.orm = drizzle(db);
  }

  /**
   * Capture a turn's pre-turn tree and pin it in the same lock region. Capture failures reject;
   * pin failures are logged so they never fail the turn.
   */
  captureBaseline(cwd: string, threadId: string, executionId: string | undefined): Promise<{ tree: string; pin: BaselinePin }> {
    return this.lock.run(cwd, async () => {
      const tree = await this.snapshots.captureRef(cwd);
      const pin = baselinePinFor(threadId, executionId, tree);
      await this.guard("pin baseline", { threadId }, async () => {
        const commit = await this.commitTree(cwd, requireObjectId(tree, "baseline tree"), null);
        await this.exec(cwd, ["update-ref", formatPinRef(this.storeId, pin), commit]);
      });
      return { tree, pin };
    });
  }

  /** Pin a snapshot row's trees as `A -> B`, then delete the baseline pin it replaces. */
  transferToSnapshot(cwd: string, snapshot: PinnableSnapshot, baseline: BaselinePin | null): Promise<boolean> {
    return this.guard("pin snapshot", { snapshotId: snapshot.id }, () => this.lock.run(cwd, async () => {
      const refBefore = requireObjectId(snapshot.refBefore, "ref_before");
      const refAfter = requireObjectId(snapshot.refAfter, "ref_after");
      const parent = await this.baselineCommitFor(cwd, baseline, refBefore)
        ?? await this.commitTree(cwd, refBefore, null);
      const commit = await this.commitTree(cwd, refAfter, parent);
      await this.exec(cwd, ["update-ref", formatPinRef(this.storeId, { kind: "snapshot", snapshotId: snapshot.id }), commit]);
      if (baseline) await this.exec(cwd, ["update-ref", "-d", formatPinRef(this.storeId, baseline)]);
    }));
  }

  /** Delete one pin this store owns. */
  release(cwd: string, pin: PinRef): Promise<boolean> {
    return this.guard("release pin", { kind: pin.kind }, () => this.lock.run(cwd, async () => {
      await this.exec(cwd, ["update-ref", "-d", formatPinRef(this.storeId, pin)]);
    }));
  }

  /**
   * Settle the baseline pin of one finished execution: transfer it to the execution's snapshot,
   * write the snapshot of an interrupted attempt, or release it. Running executions are kept.
   */
  async settleExecution(threadId: string, executionId: string, options: SnapshotPinPassOptions = {}): Promise<void> {
    await this.guard("settle execution", { threadId }, async () => {
      const cwd = this.threadWorkingDirectory(threadId);
      if (!cwd) return;
      const ref = formatPinRef(this.storeId, { kind: "baseline", threadId, executionId });
      const [listed] = await this.listPins(cwd, ref);
      if (listed && isListedBaseline(listed)) await this.settleBaseline(cwd, listed, options);
    });
  }

  /**
   * Run pin work without holding the caller. The work is tracked so shutdown can drain it before
   * the database and repositories it reads go away.
   */
  runInBackground(work: () => Promise<void>): void {
    const task = work().finally(() => this.background.delete(task));
    this.background.add(task);
  }

  /** Wait for every background pass, including passes started while draining. */
  async drain(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled(this.background);
  }

  /**
   * Reconcile this store's refs with its rows in every known repository. Interrupted attempts
   * are settled first; refs of other stores are never listed.
   */
  async sweep(options: SnapshotPinPassOptions = {}): Promise<void> {
    let repositories: SweepRepository[] = [];
    await this.guard("list repositories", {}, async () => { repositories = await this.listRepositories(); });
    for (const repository of repositories) {
      await this.guard("sweep repository", {}, () => this.lock.run(repository.cwd, () => (
        this.sweepRepository(repository, options)
      )));
    }
  }

  private async sweepRepository(repository: SweepRepository, options: SnapshotPinPassOptions): Promise<void> {
    for (const listed of await this.listPins(repository.cwd)) {
      if (isListedBaseline(listed)) await this.settleBaseline(repository.cwd, listed, options);
    }
    const pinnedSnapshots = await this.releaseOrphans(repository.cwd, options);
    for (const row of this.snapshotRowsFor(repository.workspaceIds)) {
      if (pinnedSnapshots.has(row.id) || !await this.treesExist(repository.cwd, row)) continue;
      await this.transferToSnapshot(repository.cwd, row, null);
    }
  }

  private async releaseOrphans(cwd: string, options: SnapshotPinPassOptions): Promise<Set<string>> {
    const kept = new Set<string>();
    for (const { pin } of await this.listPins(cwd)) {
      if (pin.kind === "snapshot" && this.snapshotRowExists(pin.snapshotId)) kept.add(pin.snapshotId);
      else if (pin.kind === "snapshot") await this.release(cwd, pin);
      else if (pin.kind === "baseline-tree" && !this.threadBusy(pin.threadId, options)) await this.release(cwd, pin);
    }
    return kept;
  }

  private async settleBaseline(repositoryCwd: string, listed: ListedBaseline, options: SnapshotPinPassOptions): Promise<void> {
    const { threadId, executionId } = listed.pin;
    const terminalOutcome = this.executionTerminalOutcome(executionId);
    // A live thread may still be finalizing this execution, so its snapshot write is left to the finalizer.
    if (terminalOutcome === null || options.isThreadLive?.(threadId)) return;
    const assistantId = this.assistantMessageFor(threadId, executionId);
    const snapshot = assistantId ? this.snapshotForMessage(assistantId) : null;
    if (snapshot) {
      await this.transferToSnapshot(repositoryCwd, snapshot, listed.pin);
      return;
    }
    if (assistantId && terminalOutcome === "interrupted") {
      await this.writeInterruptedSnapshot(listed, assistantId, options);
      return;
    }
    await this.release(repositoryCwd, listed.pin);
  }

  private async writeInterruptedSnapshot(listed: ListedBaseline, messageId: string, options: SnapshotPinPassOptions): Promise<void> {
    const { threadId } = listed.pin;
    const cwd = this.threadWorkingDirectory(threadId);
    if (!cwd) return;
    let captured: { refAfter: string; filesChanged: string[] } | undefined;
    const ok = await this.guard("capture interrupted attempt", { threadId }, () => this.lock.run(cwd, async () => {
      const refAfter = await this.snapshots.captureRef(cwd);
      captured = { refAfter, filesChanged: await this.snapshots.getFilesChanged(cwd, listed.tree, refAfter) };
    }));
    if (!ok || !captured) return;
    const { refAfter, filesChanged } = captured;
    if (options.stopAt === "before-row-write") throw new SnapshotPinFaultStop("before-row-write");
    let snapshotId: string | null = null;
    const written = await this.guard("write interrupted snapshot", { threadId }, async () => {
      // A concurrent pass that already wrote the row returns null; the sweep pins that row.
      ({ snapshotId } = await this.writer.execute(persistInterruptedAttemptSnapshot, {
        snapshot: { messageId, threadId, refBefore: listed.tree, refAfter, filesChanged, worktreePath: null },
        markFilesChanged: filesChanged.length > 0,
      }));
    });
    if (!written || !snapshotId) return;
    if (options.stopAt === "after-row-write") throw new SnapshotPinFaultStop("after-row-write");
    await this.transferToSnapshot(cwd, { id: snapshotId, refBefore: listed.tree, refAfter }, listed.pin);
  }

  private async baselineCommitFor(cwd: string, baseline: BaselinePin | null, refBefore: string): Promise<string | null> {
    if (!baseline) return null;
    const [listed] = await this.listPins(cwd, formatPinRef(this.storeId, baseline));
    return listed && listed.tree === refBefore ? listed.commit : null;
  }

  private async commitTree(cwd: string, tree: string, parent: string | null): Promise<string> {
    const args = ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", PIN_COMMIT_MESSAGE];
    const { stdout } = await this.git.exec(["-C", cwd, ...args], {
      timeout: RealGitExecutor.DEFAULT_TIMEOUT, env: { ...process.env, ...PIN_COMMIT_ENV },
    });
    return requireObjectId(stdout.trim(), "pin commit");
  }

  private async exec(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await this.git.exec(["-C", cwd, ...args], { timeout: RealGitExecutor.DEFAULT_TIMEOUT });
    return stdout;
  }

  private async listPins(cwd: string, exactRef?: string): Promise<ListedPin[]> {
    const stdout = await this.exec(cwd, [
      "for-each-ref", "--format=%(refname) %(objectname) %(tree)", exactRef ?? storeRefPrefix(this.storeId),
    ]);
    const listed: ListedPin[] = [];
    for (const line of stdout.split("\n")) {
      const [ref, commit, tree] = line.trim().split(" ");
      const pin = ref ? parsePinRef(this.storeId, ref) : null;
      if (!ref || !pin || !commit || !tree) continue;
      listed.push({ ref, pin, commit, tree });
    }
    return listed;
  }

  private async treesExist(cwd: string, row: PinnableSnapshot): Promise<boolean> {
    if (!OBJECT_ID.test(row.refBefore) || !OBJECT_ID.test(row.refAfter)) return false;
    for (const tree of [row.refBefore, row.refAfter]) {
      const exists = await this.exec(cwd, ["cat-file", "-t", tree]).then((out) => out.trim() === "tree", () => false);
      if (!exists) return false;
    }
    return true;
  }

  /** Workspaces grouped by Git common directory, since linked worktrees share one ref store. */
  private async listRepositories(): Promise<SweepRepository[]> {
    const byCommonDirectory = new Map<string, { cwd: string; workspaceIds: Set<string> }>();
    for (const workspace of this.orm.select({ id: workspaces.id, path: workspaces.path }).from(workspaces).all()) {
      let commonDirectory: string | undefined;
      await this.guard("resolve repository", { workspaceId: workspace.id }, async () => {
        const stdout = await this.exec(workspace.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        commonDirectory = normalizePathForComparison(stdout.trim(), this.hostRuntime.platform);
      });
      if (!commonDirectory) continue;
      const repository = byCommonDirectory.get(commonDirectory) ?? { cwd: workspace.path, workspaceIds: new Set<string>() };
      repository.workspaceIds.add(workspace.id);
      byCommonDirectory.set(commonDirectory, repository);
    }
    return [...byCommonDirectory.values()];
  }

  private threadWorkingDirectory(threadId: string): string | null {
    const row = this.orm.select({ mode: threads.mode, worktreePath: threads.worktreePath, workspacePath: workspaces.path })
      .from(threads).innerJoin(workspaces, eq(workspaces.id, threads.workspaceId))
      .where(eq(threads.id, threadId)).get();
    if (!row) return null;
    return row.mode === "worktree" && row.worktreePath ? row.worktreePath : row.workspacePath;
  }

  /** Undefined when the execution has no checkpoint; null while it is unfinished. */
  private executionTerminalOutcome(executionId: string): string | null | undefined {
    const row = this.orm.select({ terminalOutcome: canonicalAgentIngestCheckpoints.terminalOutcome })
      .from(canonicalAgentIngestCheckpoints).where(eq(canonicalAgentIngestCheckpoints.executionId, executionId)).get();
    return row ? row.terminalOutcome : undefined;
  }

  private threadBusy(threadId: string, options: SnapshotPinPassOptions): boolean {
    if (options.isThreadLive?.(threadId)) return true;
    return Boolean(this.orm.select({ executionId: canonicalAgentIngestCheckpoints.executionId })
      .from(canonicalAgentIngestCheckpoints)
      .where(and(eq(canonicalAgentIngestCheckpoints.threadId, threadId), isNull(canonicalAgentIngestCheckpoints.terminalOutcome)))
      .get());
  }

  private assistantMessageFor(threadId: string, executionId: string): string | null {
    return this.orm.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant"), eq(messages.outcomeExecutionId, executionId)))
      .get()?.id ?? null;
  }

  private snapshotForMessage(messageId: string): PinnableSnapshot | null {
    return this.orm.select({ id: turnSnapshots.id, refBefore: turnSnapshots.refBefore, refAfter: turnSnapshots.refAfter })
      .from(turnSnapshots).where(eq(turnSnapshots.messageId, messageId))
      .orderBy(asc(turnSnapshots.createdAt)).get() ?? null;
  }

  private snapshotRowExists(snapshotId: string): boolean {
    return Boolean(this.orm.select({ id: turnSnapshots.id }).from(turnSnapshots).where(eq(turnSnapshots.id, snapshotId)).get());
  }

  /**
   * Rows to backfill. A copied file's older rows stay pinned by the store it was copied from, and
   * pinning them again would make every development copy write refs into the user's repositories.
   */
  private snapshotRowsFor(workspaceIds: ReadonlySet<string>): PinnableSnapshot[] {
    const inheritedBefore = this.orm.select({ inheritedBefore: storeIdentity.inheritedBefore })
      .from(storeIdentity).get()?.inheritedBefore;
    return this.orm.select({
      id: turnSnapshots.id, refBefore: turnSnapshots.refBefore, refAfter: turnSnapshots.refAfter,
      workspaceId: threads.workspaceId,
    }).from(turnSnapshots).innerJoin(threads, eq(threads.id, turnSnapshots.threadId))
      .where(inheritedBefore ? gte(turnSnapshots.createdAt, inheritedBefore) : undefined).all()
      .filter((row) => workspaceIds.has(row.workspaceId));
  }

  /** Pin work is best effort: log and continue. Only the test fault hook escapes. */
  private async guard(action: string, context: Record<string, string>, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      if (error instanceof SnapshotPinFaultStop) throw error;
      logger.warn("Snapshot ref pin failed", {
        action, ...context, error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
