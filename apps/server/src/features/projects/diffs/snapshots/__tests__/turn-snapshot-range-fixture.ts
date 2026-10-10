import "reflect-metadata";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { canonicalAgentIngestCheckpoints, canonicalAgentItems, canonicalAgentThreads, canonicalAgentTurns, messages, threads, workspaces } from "../../../../../runtime/persistence/sqlite/schema.js";
import { deriveTurnAssistantMessageId } from "../../../../agents/turns/turn-assistant-message-id.js";
import { openAgentStorageTestDatabase, agentStorageTestWriter, closeAgentStorageTestDatabases } from "../../../../agents/__tests__/agent-storage-fixture.js";
import { TurnSnapshotRepo } from "../../../../agents/turns/persistence/turn-snapshot-repo.js";
import { TurnDiffRepo } from "../../../../agents/turns/persistence/turn-diff-repo.js";
import { TurnDiffStore } from "../../../../agents/turns/persistence/turn-diff-store.js";
import { TurnDiffService } from "../../../../agents/turns/turn-diff-service.js";
import { ThreadRepo } from "../../../../thread-control/persistence/thread-repo.js";
import { WorkspaceRepo } from "../../../persistence/workspace-repo.js";
import { RealGitExecutor } from "../../../git/execution/real-git-executor.js";
import { GitWorktreeService } from "../../../git/git-worktree-service.js";
import { SnapshotService } from "../snapshot-service.js";
import { TurnSnapshotRangeReader } from "../turn-snapshot-range.js";
import type { TurnDiffRouterDeps } from "../../transport/turn-diff-rpc.js";

/** A real repository and database shared by the public snapshot reader tests. */
export async function createSnapshotRangeFixture() {
  const scratch = NodePath.resolve(process.cwd(), "../../.codex/tmp");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const directory = NodeFS.mkdtempSync(NodePath.join(scratch, "snapshot-range-"));
  NodeChildProcess.execFileSync("git", ["init", "--template=", "--quiet", "--initial-branch=main", directory]);
  const db = openAgentStorageTestDatabase();
  const writer = agentStorageTestWriter(db);
  const orm = drizzle(db);
  const now = new Date().toISOString();
  orm.insert(workspaces).values({ id: "ws", name: "Fixture", path: directory, createdAt: now, updatedAt: now }).run();
  orm.insert(threads).values({ id: "thread", workspaceId: "ws", title: "Fixture", branch: "main", createdAt: now, updatedAt: now }).run();
  orm.insert(canonicalAgentThreads).values({ id: "thread", workspaceId: "ws", rootThreadId: "thread", providerId: "codex",
    activityState: "Idle", createdAt: now, updatedAt: now }).run();
  const snapshotService = new SnapshotService(new RealGitExecutor());
  const snapshots = new TurnSnapshotRepo(db, writer);
  const ranges = new TurnSnapshotRangeReader(db, snapshots);
  const deps: TurnDiffRouterDeps = { turnSnapshotRepo: snapshots, turnSnapshotRanges: ranges, snapshotService,
    turnDiffs: new TurnDiffService(new TurnDiffRepo(db, writer)), threadService: new ThreadRepo(db, writer),
    workspaceService: new WorkspaceRepo(db, writer), gitWorktrees: { resolveWorkingDir: GitWorktreeService.prototype.resolveWorkingDir },
    sweepSnapshotPins: async () => {} };
  let sequence = 0;
  async function attempt(input: { id: string; attemptOf?: string; edits?: Record<string, string>; missing?: boolean; noAssistant?: boolean; status?: string; ageDays?: number }) {
    const date = new Date(Date.now() - (input.ageDays ?? 0) * 86_400_000).toISOString();
    const executionId = `execution-${input.id}`;
    const status = input.status ?? "Completed";
    const live = ["Running", "Pending"].includes(status);
    const messageId = live ? deriveTurnAssistantMessageId("thread", `user-${input.id}`) : `message-${input.id}`;
    orm.insert(canonicalAgentTurns).values({ id: input.id, threadId: "thread", executionId, attemptOf: input.attemptOf,
      status, triggerJson: '{"kind":"user"}', permissionMode: "supervised", createdAt: date, updatedAt: date }).run();
    orm.insert(canonicalAgentIngestCheckpoints).values({ executionId, threadId: "thread", turnId: input.id,
      phase: status.toLowerCase(), terminalOutcome: null,
      lastAcceptedSequence: 1, lastDurableSequence: 1, updatedAt: date }).run();
    orm.insert(messages).values({ id: `user-${input.id}`, threadId: "thread", sourceTurnId: input.id,
      role: "user", content: "Edit files", sequence: ++sequence, timestamp: date }).run();
    orm.insert(canonicalAgentItems).values({ id: `message:user-${input.id}`, threadId: "thread", turnId: input.id,
      kind: "user-message", payloadJson: "{}", createdAt: date, updatedAt: date }).run();
    if (input.noAssistant) return null;
    orm.insert(messages).values({ id: messageId, threadId: "thread", outcomeExecutionId: live ? null : executionId, isInternal: Number(live),
      role: "assistant", content: "Result", sequence: ++sequence, timestamp: date }).run();
    const before = await snapshotService.captureRef(directory);
    for (const [path, text] of Object.entries(input.edits ?? {})) NodeFS.writeFileSync(NodePath.join(directory, path), text);
    const after = await snapshotService.captureRef(directory);
    if (input.missing) return null;
    const snapshot = await snapshots.create({ threadId: "thread", messageId, refBefore: before, refAfter: after,
      filesChanged: Object.keys(input.edits ?? {}), worktreePath: directory });
    db.prepare("UPDATE turn_snapshots SET created_at = ? WHERE id = ?").run(date, snapshot.id);
    return snapshot;
  }
  function native(id: string, patch: string, source: "native" | "tracked" = "native") {
    new TurnDiffStore(db).create({ id: `native-${id}`, thread_id: "thread", message_id: `message-${id}`, source, patch, revision: 1 });
  }
  return { directory, db, deps, ranges, snapshots, snapshotService, attempt, native,
    async close() { await closeAgentStorageTestDatabases(); NodeFS.rmSync(directory, { recursive: true, force: true }); } };
}
