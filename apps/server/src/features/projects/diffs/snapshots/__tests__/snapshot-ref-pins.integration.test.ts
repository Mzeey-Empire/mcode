import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@mcode/shared";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { openDatabase } from "../../../../../runtime/persistence/sqlite/database.js";
import { ApplicationDatabaseWriter } from "../../../../../runtime/persistence/sqlite/application-database-writer.js";
import { MessageStore } from "../../../../agents/conversation/persistence/message-store.js";
import { CanonicalAgentStore } from "../../../../agents/canonical/canonical-agent-store.js";
import { CanonicalAgentBoundary } from "../../../../agents/canonical/canonical-agent-boundary.js";
import { CanonicalAgentWriterClient } from "../../../../agents/canonical/canonical-agent-writer-client.js";
import { ParentAssistantTextCheckpointService } from "../../../../agents/turns/parent-assistant-text-checkpoint-service.js";
import { TurnRecoveryService } from "../../../../agents/recovery/turn-recovery-service.js";
import { TurnSnapshotRepo } from "../../../../agents/turns/persistence/turn-snapshot-repo.js";
import { persistTurnSnapshot } from "../../../../agents/turns/persistence/turn-finalization-write-operations.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { AttachmentService } from "../../../../attachments/storage/attachment-service.js";
import { RealGitExecutor } from "../../../git/execution/real-git-executor.js";
import type { GitExecOptions, GitExecResult, GitExecutor } from "../../../git/execution/types.js";
import { RepositoryGitMutationLock } from "../../../git/repository-git-mutation-lock.js";
import { SnapshotService } from "../snapshot-service.js";
import { ensureSnapshotStoreId, StoreIdSchema, type StoreId } from "../snapshot-store-identity.js";
import {
  formatPinRef,
  parsePinRef,
  SnapshotPinFaultStop,
  SnapshotRefPins,
  storeRefPrefix,
} from "../snapshot-ref-pins.js";

const TEST_TIMEOUT_MS = 120_000;
const NOW = "2026-10-09T09:00:00.000Z";
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "Mcode Test",
  GIT_AUTHOR_EMAIL: "test@mcode.test",
  GIT_COMMITTER_NAME: "Mcode Test",
  GIT_COMMITTER_EMAIL: "test@mcode.test",
};

const temporaryDirectories: string[] = [];
const openStores: TestStore[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...COMMIT_ENV },
  }).trim();
}

/** A repository with one commit. `withIdentity: false` leaves `user.email` unset. */
function createRepo(withIdentity = true): string {
  const repo = temporaryDirectory("mcode-pin-repo-");
  git(repo, ["init", "-b", "main"]);
  if (withIdentity) {
    git(repo, ["config", "user.email", "test@mcode.test"]);
    git(repo, ["config", "user.name", "Mcode Test"]);
  }
  NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "a.ts"]);
  const commit = git(repo, ["commit-tree", git(repo, ["write-tree"]), "-m", "initial"]);
  git(repo, ["update-ref", "refs/heads/main", commit]);
  return repo;
}

function addLinkedWorktree(repo: string): string {
  const worktree = NodePath.join(temporaryDirectory("mcode-pin-wt-"), "linked");
  git(repo, ["worktree", "add", "-b", "linked", worktree]);
  return worktree;
}

function listRefs(repo: string, prefix = "refs/mcode/"): string[] {
  const out = git(repo, ["for-each-ref", "--format=%(refname)", prefix]);
  return out ? out.split("\n").sort() : [];
}

function objectExists(repo: string, object: string): boolean {
  try {
    git(repo, ["cat-file", "-t", object]);
    return true;
  } catch {
    return false;
  }
}

function gcPruneNow(repo: string): void {
  git(repo, ["gc", "--prune=now", "--quiet"]);
}

/** One database file with the services a server process would build around it. */
interface TestStore {
  readonly dbPath: string;
  readonly db: Database;
  readonly writer: ApplicationDatabaseWriter;
  readonly storeId: StoreId;
  readonly snapshots: SnapshotService;
  readonly pins: SnapshotRefPins;
  readonly messages: MessageStore;
  readonly canonical: CanonicalAgentStore;
  readonly recovery: TurnRecoveryService;
}

async function openStore(dbPath: string, gitExecutor: GitExecutor = new RealGitExecutor()): Promise<TestStore> {
  const db = openDatabase({ dbPath });
  const writer = new ApplicationDatabaseWriter(dbPath);
  const storeId = await ensureSnapshotStoreId(writer, dbPath, hostRuntime.platform);
  const lock = new RepositoryGitMutationLock(hostRuntime);
  const snapshots = new SnapshotService(gitExecutor, lock);
  const published = vi.fn();
  const store: TestStore = {
    dbPath, db, writer, storeId, snapshots,
    pins: new SnapshotRefPins(gitExecutor, storeId, db, writer, lock, snapshots, hostRuntime),
    messages: new MessageStore(db),
    canonical: new CanonicalAgentStore(db, published),
    recovery: new TurnRecoveryService(
      new CanonicalAgentBoundary(db, writer, new CanonicalAgentWriterClient(writer), published),
      new ThreadRepo(db, writer),
      new AttachmentService(),
      new ParentAssistantTextCheckpointService(db, writer),
    ),
  };
  openStores.push(store);
  return store;
}

async function closeHandles(store: TestStore): Promise<void> {
  await store.writer.close();
  store.db.close(true);
}

async function closeStore(store: TestStore): Promise<void> {
  const index = openStores.indexOf(store);
  if (index < 0) return;
  openStores.splice(index, 1);
  await closeHandles(store);
}

/** Close the store and reopen the same file, as a server restart does. */
async function restart(store: TestStore): Promise<TestStore> {
  await closeStore(store);
  return openStore(store.dbPath);
}

async function newStore(): Promise<TestStore> {
  return openStore(NodePath.join(temporaryDirectory("mcode-pin-db-"), "app.sqlite"));
}

function seedThread(store: TestStore, input: { workspaceId: string; path: string; threadId: string; worktreePath?: string }): void {
  store.db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(input.workspaceId, input.workspaceId, input.path, NOW, NOW);
  store.db.prepare(
    "INSERT INTO threads (id, workspace_id, title, branch, provider, status, mode, worktree_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    input.threadId, input.workspaceId, input.threadId, "main", "codex", "active",
    input.worktreePath ? "worktree" : "direct", input.worktreePath ?? null, NOW, NOW,
  );
}

/** Start a canonical turn, optionally with a streamed assistant row, the way a provider run does. */
function startTurn(store: TestStore, input: { threadId: string; workspaceId: string; executionId: string; assistantId?: string }): void {
  const turnId = `turn-${input.executionId}`;
  store.canonical.startParentTurn({
    thread: { id: input.threadId, workspaceId: input.workspaceId, providerId: "codex", createdAt: NOW },
    turnId,
    executionId: input.executionId,
    permissionMode: "supervised",
    providerIdentities: [],
    projectUserMessage: () => store.messages.create(input.threadId, "user", "edit a.ts", 1),
  });
  if (!input.assistantId) return;
  const assistant = store.messages.createAssistantIdempotent({
    id: input.assistantId, threadId: input.threadId, content: "editing", sequence: 2, isInternal: true,
  });
  const thread = store.canonical.loadThread(input.threadId);
  if (!thread) throw new Error("The canonical thread was not persisted");
  const itemId = `message:${assistant.id}`;
  store.canonical.commit({
    threadId: input.threadId,
    turnId,
    executionId: input.executionId,
    phase: "running",
    events: [{
      eventId: `${input.executionId}:assistant`,
      routing: { threadId: input.threadId, turnId, executionId: input.executionId, itemId },
      sourceProviderId: thread.providerId,
      sourceIdentities: thread.providerIdentities,
      payload: {
        type: "item.recorded",
        item: {
          id: itemId, threadId: input.threadId, turnId, kind: "message",
          providerIdentities: thread.providerIdentities,
          payload: { projection: "message", message: assistant },
          createdAt: assistant.timestamp, updatedAt: assistant.timestamp,
        },
      },
    }],
  });
}

interface SnapshotRow { id: string; ref_before: string; ref_after: string; files_changed: string }

function snapshotRows(store: TestStore, messageId: string): SnapshotRow[] {
  return store.db.query<SnapshotRow, [string]>("SELECT id, ref_before, ref_after, files_changed FROM turn_snapshots WHERE message_id = ?")
    .all(messageId);
}

async function writeSnapshotRow(store: TestStore, input: { messageId: string; threadId: string; refBefore: string; refAfter: string }): Promise<string> {
  const { snapshotId } = await store.writer.execute(persistTurnSnapshot, {
    snapshot: { ...input, filesChanged: ["a.ts"], worktreePath: null },
    markFilesChanged: true,
  });
  return snapshotId;
}

/** Arrange the restart case: a turn pinned its baseline, edited a.ts, then the process died. */
async function interruptedTurn(repo: string, options: { assistant?: boolean } = {}) {
  const store = await newStore();
  const executionId = "00000000-0000-4000-8000-000000000101";
  seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-1" });
  startTurn(store, {
    threadId: "thread-1", workspaceId: "workspace-1", executionId,
    ...(options.assistant === false ? {} : { assistantId: "assistant-1" }),
  });
  NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'dirty before';\n");
  const { tree: baseline, pin } = await store.pins.captureBaseline(repo, "thread-1", executionId);
  NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'edited by the turn';\n");
  const baselineRef = formatPinRef(store.storeId, pin);
  return { store, executionId, baseline, baselineRef };
}

/** Wraps the real executor and rejects one Git subcommand. */
class FailingGitExecutor implements GitExecutor {
  private readonly real = new RealGitExecutor();
  constructor(private readonly failing: string) {}
  exec(args: string[], opts?: GitExecOptions): Promise<GitExecResult> {
    if (args.includes(this.failing)) return Promise.reject(new Error(`${this.failing} failed`));
    return this.real.exec(args, opts);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of openStores.splice(0)) await closeHandles(store);
  for (const directory of temporaryDirectories.splice(0)) NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("pin ref names", () => {
  const storeId = StoreIdSchema.parse("6f4f2c1e-8d2a-4b8e-9c1f-0a1b2c3d4e5f");

  it("names baselines by thread and execution and parses only its own namespace", () => {
    const ref = formatPinRef(storeId, { kind: "baseline", threadId: "thread-1", executionId: "exec-1" });
    expect(ref).toBe(`refs/mcode/${storeId}/baselines/thread-1/exec-1`);
    expect(parsePinRef(storeId, ref)).toEqual({ kind: "baseline", threadId: "thread-1", executionId: "exec-1" });
    expect(parsePinRef(storeId, `refs/mcode/${storeId}/reverts/r-1`)).toBeNull();
    expect(parsePinRef(storeId, "refs/mcode/another-store/snapshots/s-1")).toBeNull();
    expect(() => formatPinRef(storeId, { kind: "snapshot", snapshotId: "../heads/main" })).toThrow();
  });
});

describe("SnapshotRefPins", () => {
  it("keeps a pinned dirty-tree snapshot diffable after gc while an unpinned tree is pruned", async () => {
    const repo = createRepo();
    const store = await newStore();
    seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-1" });
    const message = store.messages.create("thread-1", "assistant", "done", 1);
    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'dirty';\n");
    const refBefore = await store.snapshots.captureRef(repo);
    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'turn edit';\n");
    const refAfter = await store.snapshots.captureRef(repo);
    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'never pinned';\n");
    const unpinned = await store.snapshots.captureRef(repo);
    const snapshotId = await writeSnapshotRow(store, { messageId: message.id, threadId: "thread-1", refBefore, refAfter });

    await expect(store.pins.transferToSnapshot(repo, { id: snapshotId, refBefore, refAfter }, null)).resolves.toBe(true);
    gcPruneNow(repo);

    expect(objectExists(repo, unpinned)).toBe(false);
    expect(await store.snapshots.getDiff(repo, refBefore, refAfter)).toContain("+export const a = 'turn edit';");
  }, TEST_TIMEOUT_MS);

  it("keeps a dirty baseline through gc and a restart, then moves it to the snapshot pin", async () => {
    const repo = createRepo();
    let store = await newStore();
    seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-1" });
    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'dirty baseline';\n");
    const { tree: refBefore, pin } = await store.pins.captureBaseline(repo, "thread-1", "exec-1");
    expect(listRefs(repo)).toEqual([`refs/mcode/${store.storeId}/baselines/thread-1/exec-1`]);

    gcPruneNow(repo);
    store = await restart(store);
    expect(objectExists(repo, refBefore)).toBe(true);

    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'turn edit';\n");
    const refAfter = await store.snapshots.captureRef(repo);
    const message = store.messages.create("thread-1", "assistant", "done", 1);
    const snapshotId = await writeSnapshotRow(store, { messageId: message.id, threadId: "thread-1", refBefore, refAfter });
    await store.pins.transferToSnapshot(repo, { id: snapshotId, refBefore, refAfter }, pin);

    expect(listRefs(repo)).toEqual([`refs/mcode/${store.storeId}/snapshots/${snapshotId}`]);
    expect(git(repo, ["rev-parse", `refs/mcode/${store.storeId}/snapshots/${snapshotId}^^{tree}`])).toBe(refBefore);
    gcPruneNow(repo);
    expect(await store.snapshots.getDiff(repo, refBefore, refAfter)).toContain("-export const a = 'dirty baseline';");
  }, TEST_TIMEOUT_MS);

  it("releases the baseline of a turn that wrote no snapshot", async () => {
    const repo = createRepo();
    const store = await newStore();
    const { pin } = await store.pins.captureBaseline(repo, "thread-1", "exec-1");
    await store.pins.release(repo, pin);
    expect(listRefs(repo)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("writes the snapshot of a turn interrupted by a restart from its pinned baseline", async () => {
    const repo = createRepo();
    const { store: first, executionId, baseline, baselineRef } = await interruptedTurn(repo);
    const store = await restart(first);
    await expect(store.recovery.reconcileOnStartup()).resolves.toEqual({ interrupted: [executionId] });

    await store.pins.settleExecution("thread-1", executionId);

    const rows = snapshotRows(store, "assistant-1");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.ref_before).toBe(baseline);
    expect(row?.ref_after).toBe(await store.snapshots.captureRef(repo));
    expect(JSON.parse(row?.files_changed ?? "[]")).toContain("a.ts");
    expect(listRefs(repo)).toEqual([`refs/mcode/${store.storeId}/snapshots/${row?.id}`]);
    expect(listRefs(repo)).not.toContain(baselineRef);
    gcPruneNow(repo);
    expect(await store.snapshots.getDiff(repo, baseline, row?.ref_after ?? "")).toContain("+export const a = 'edited by the turn';");
  }, TEST_TIMEOUT_MS);

  it("recovers a second crash before the row write on the next start", async () => {
    const repo = createRepo();
    const interrupted = await interruptedTurn(repo);
    let store = await restart(interrupted.store);
    await store.recovery.reconcileOnStartup();
    await expect(store.pins.sweep({ stopAt: "before-row-write" })).rejects.toBeInstanceOf(SnapshotPinFaultStop);
    expect(snapshotRows(store, "assistant-1")).toHaveLength(0);

    store = await restart(store);
    await expect(store.recovery.reconcileOnStartup()).resolves.toEqual({ interrupted: [] });
    await store.pins.sweep();

    const rows = snapshotRows(store, "assistant-1");
    expect(rows).toHaveLength(1);
    expect(listRefs(repo)).toEqual([`refs/mcode/${store.storeId}/snapshots/${rows[0]?.id}`]);
    gcPruneNow(repo);
    expect(await store.snapshots.getDiff(repo, interrupted.baseline, rows[0]?.ref_after ?? "")).toContain("a.ts");
  }, TEST_TIMEOUT_MS);

  it("recovers a second crash after the row write without a second row", async () => {
    const repo = createRepo();
    const interrupted = await interruptedTurn(repo);
    let store = await restart(interrupted.store);
    await store.recovery.reconcileOnStartup();
    await expect(store.pins.sweep({ stopAt: "after-row-write" })).rejects.toBeInstanceOf(SnapshotPinFaultStop);
    expect(snapshotRows(store, "assistant-1")).toHaveLength(1);
    expect(listRefs(repo)).toEqual([interrupted.baselineRef]);

    store = await restart(store);
    await store.recovery.reconcileOnStartup();
    await store.pins.sweep();
    const rows = snapshotRows(store, "assistant-1");
    const settled = [`refs/mcode/${store.storeId}/snapshots/${rows[0]?.id}`];
    expect(rows).toHaveLength(1);
    expect(listRefs(repo)).toEqual(settled);

    store = await restart(store);
    await store.recovery.reconcileOnStartup();
    await store.pins.sweep();
    expect(snapshotRows(store, "assistant-1")).toEqual(rows);
    expect(listRefs(repo)).toEqual(settled);
  }, TEST_TIMEOUT_MS);

  it("keeps the baseline when the snapshot write fails and writes the row on the next start", async () => {
    const repo = createRepo();
    const interrupted = await interruptedTurn(repo);
    let store = await restart(interrupted.store);
    await store.recovery.reconcileOnStartup();
    const warn = vi.spyOn(logger, "warn");
    const failingWriter: Pick<ApplicationDatabaseWriter, "execute"> = {
      execute: () => Promise.reject(new Error("database write failed")),
    };
    const failingPins = new SnapshotRefPins(
      new RealGitExecutor(), store.storeId, store.db, failingWriter, new RepositoryGitMutationLock(hostRuntime), store.snapshots, hostRuntime,
    );

    await failingPins.sweep();
    expect(listRefs(repo)).toEqual([interrupted.baselineRef]);
    expect(snapshotRows(store, "assistant-1")).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("Snapshot ref pin failed", expect.objectContaining({ action: "write interrupted snapshot" }));

    store = await restart(store);
    await store.pins.sweep();
    expect(snapshotRows(store, "assistant-1")).toHaveLength(1);
    expect(listRefs(repo)).toEqual([`refs/mcode/${store.storeId}/snapshots/${snapshotRows(store, "assistant-1")[0]?.id}`]);
  }, TEST_TIMEOUT_MS);

  it("deletes the baseline of an interrupted attempt that already has a row, without a new row", async () => {
    const repo = createRepo();
    const interrupted = await interruptedTurn(repo);
    const store = await restart(interrupted.store);
    await store.recovery.reconcileOnStartup();
    const refAfter = await store.snapshots.captureRef(repo);
    const snapshotId = await writeSnapshotRow(store, {
      messageId: "assistant-1", threadId: "thread-1", refBefore: interrupted.baseline, refAfter,
    });

    await store.pins.sweep();

    expect(snapshotRows(store, "assistant-1").map((row) => row.id)).toEqual([snapshotId]);
    expect(listRefs(repo)).toEqual([`refs/mcode/${store.storeId}/snapshots/${snapshotId}`]);
  }, TEST_TIMEOUT_MS);

  it("deletes the baseline of an interrupted attempt with no assistant row", async () => {
    const repo = createRepo();
    const interrupted = await interruptedTurn(repo, { assistant: false });
    const store = await restart(interrupted.store);
    await store.recovery.reconcileOnStartup();

    await store.pins.sweep();

    expect(store.db.prepare("SELECT COUNT(*) AS count FROM turn_snapshots").get()).toEqual({ count: 0 });
    expect(listRefs(repo)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("keeps a running execution's baseline and a live thread's tree baseline", async () => {
    const repo = createRepo();
    const store = await newStore();
    const executionId = "00000000-0000-4000-8000-000000000102";
    seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-1" });
    startTurn(store, { threadId: "thread-1", workspaceId: "workspace-1", executionId });
    const running = await store.pins.captureBaseline(repo, "thread-1", executionId);
    seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-2" });
    const live = await store.pins.captureBaseline(repo, "thread-2", undefined);
    seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-3" });
    NodeFS.writeFileSync(NodePath.join(repo, "b.ts"), "export const b = 1;\n");
    const stale = await store.pins.captureBaseline(repo, "thread-3", undefined);

    await store.pins.sweep({ isThreadLive: (threadId) => threadId === "thread-2" });

    expect(listRefs(repo)).toEqual([
      formatPinRef(store.storeId, live.pin),
      formatPinRef(store.storeId, running.pin),
    ].sort());
    expect(listRefs(repo)).not.toContain(formatPinRef(store.storeId, stale.pin));
  }, TEST_TIMEOUT_MS);

  it("sweeps only its own store's orphans when two stores share a repository and a linked worktree", async () => {
    const repo = createRepo();
    const worktree = addLinkedWorktree(repo);
    const storeA = await newStore();
    const storeB = await newStore();
    expect(storeA.storeId).not.toBe(storeB.storeId);
    seedThread(storeA, { workspaceId: "workspace-a", path: repo, threadId: "thread-a" });
    seedThread(storeB, { workspaceId: "workspace-b", path: worktree, threadId: "thread-b" });
    const head = git(repo, ["rev-parse", "HEAD"]);
    for (const store of [storeA, storeB]) {
      git(repo, ["update-ref", `${storeRefPrefix(store.storeId)}snapshots/orphan-row`, head]);
      git(repo, ["update-ref", `${storeRefPrefix(store.storeId)}reverts/hand-made`, head]);
    }

    await storeA.pins.sweep();
    expect(listRefs(repo)).toEqual([
      `${storeRefPrefix(storeA.storeId)}reverts/hand-made`,
      `${storeRefPrefix(storeB.storeId)}reverts/hand-made`,
      `${storeRefPrefix(storeB.storeId)}snapshots/orphan-row`,
    ].sort());

    await storeB.pins.sweep();
    expect(listRefs(repo)).toEqual([
      `${storeRefPrefix(storeA.storeId)}reverts/hand-made`,
      `${storeRefPrefix(storeB.storeId)}reverts/hand-made`,
    ].sort());
  }, TEST_TIMEOUT_MS);

  it("pins in a linked worktree shared with the main checkout", async () => {
    const repo = createRepo();
    const worktree = addLinkedWorktree(repo);
    const store = await newStore();
    seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-1", worktreePath: worktree });
    NodeFS.writeFileSync(NodePath.join(worktree, "a.ts"), "export const a = 'worktree dirty';\n");

    const { tree, pin } = await store.pins.captureBaseline(worktree, "thread-1", "exec-1");

    expect(listRefs(repo)).toEqual([formatPinRef(store.storeId, pin)]);
    gcPruneNow(repo);
    expect(objectExists(repo, tree)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("pins in a repository with no user.email", async () => {
    const globalConfig = NodePath.join(temporaryDirectory("mcode-pin-config-"), "gitconfig");
    NodeFS.writeFileSync(globalConfig, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    try {
      const repo = createRepo(false);
      expect(() => git(repo, ["config", "user.email"])).toThrow();
      const store = await newStore();
      NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'dirty';\n");

      const { pin } = await store.pins.captureBaseline(repo, "thread-1", "exec-1");

      expect(listRefs(repo)).toEqual([formatPinRef(store.storeId, pin)]);
      expect(git(repo, ["log", "-1", "--format=%an <%ae>", formatPinRef(store.storeId, pin)])).toBe("Mcode <mcode@localhost>");
    } finally {
      vi.unstubAllEnvs();
    }
  }, TEST_TIMEOUT_MS);

  it("removes an expired row's pin and backfills unpinned or copied rows", async () => {
    const repo = createRepo();
    const store = await newStore();
    seedThread(store, { workspaceId: "workspace-1", path: repo, threadId: "thread-1" });
    const refBefore = await store.snapshots.captureRef(repo);
    NodeFS.writeFileSync(NodePath.join(repo, "a.ts"), "export const a = 'edit';\n");
    const refAfter = await store.snapshots.captureRef(repo);
    const expiredMessage = store.messages.create("thread-1", "assistant", "old", 1);
    const unpinnedMessage = store.messages.create("thread-1", "assistant", "new", 2);
    const expiredId = await writeSnapshotRow(store, { messageId: expiredMessage.id, threadId: "thread-1", refBefore, refAfter });
    await store.pins.transferToSnapshot(repo, { id: expiredId, refBefore, refAfter }, null);
    const unpinnedId = await writeSnapshotRow(store, { messageId: unpinnedMessage.id, threadId: "thread-1", refBefore, refAfter });
    store.db.prepare("UPDATE turn_snapshots SET created_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", expiredId);

    await new TurnSnapshotRepo(store.db, store.writer).deleteExpired(30);
    await store.pins.sweep();

    expect(listRefs(repo)).toEqual([`refs/mcode/${store.storeId}/snapshots/${unpinnedId}`]);
  }, TEST_TIMEOUT_MS);

  it("logs pin failures without failing the capture", async () => {
    const repo = createRepo();
    const store = await openStore(
      NodePath.join(temporaryDirectory("mcode-pin-db-"), "app.sqlite"),
      new FailingGitExecutor("update-ref"),
    );
    const warn = vi.spyOn(logger, "warn");

    const { tree } = await store.pins.captureBaseline(repo, "thread-1", "exec-1");

    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(listRefs(repo)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("Snapshot ref pin failed", expect.objectContaining({ action: "pin baseline" }));
  }, TEST_TIMEOUT_MS);
});

describe("snapshot store identity", () => {
  it("mints a new id for a copied database file and keeps the original's id", async () => {
    const original = await newStore();
    const originalId = original.storeId;
    await closeStore(original);
    const copyPath = NodePath.join(temporaryDirectory("mcode-pin-copy-"), "app.sqlite");
    NodeFS.copyFileSync(original.dbPath, copyPath);

    const copy = await openStore(copyPath);
    const reopened = await openStore(original.dbPath);

    expect(copy.storeId).not.toBe(originalId);
    expect(reopened.storeId).toBe(originalId);
  }, TEST_TIMEOUT_MS);
});
