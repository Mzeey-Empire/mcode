import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import type { FileEffect, TurnRevertScope, TurnRevertResult, TurnRuntimeSnapshot } from "@mcode/contracts";
import { createSnapshotRangeFixture } from "../../snapshots/__tests__/turn-snapshot-range-fixture.js";
import { agentStorageTestWriter } from "../../../../agents/__tests__/agent-storage-fixture.js";
import { TurnRevertStore } from "../../../../agents/turns/persistence/turn-revert-store.js";
import { RepositoryGitMutationLock } from "../../../git/repository-git-mutation-lock.js";
import { RealGitExecutor } from "../../../git/execution/real-git-executor.js";
import { SnapshotService } from "../../snapshots/snapshot-service.js";
import { SnapshotRefPins } from "../../snapshots/snapshot-ref-pins.js";
import { PIN_COMMIT_ENV, StoreIdSchema } from "../../snapshots/snapshot-store-identity.js";
import { TurnRevertService, type TurnRevertDeps, type RevertFaultPoint } from "../turn-revert-service.js";
import { turnRevertContext } from "../turn-revert-context.js";

/** Real database, writer worker and repository. No Git or persistence mocks. */
export async function revertFixture() {
  const base = await createSnapshotRangeFixture();
  const lock = new RepositoryGitMutationLock(hostRuntime);
  const gitExecutor = new RealGitExecutor();
  const snapshots = new SnapshotService(gitExecutor, lock);
  const writer = agentStorageTestWriter(base.db);
  const store = new TurnRevertStore(base.db);
  const storeId = StoreIdSchema.parse(NodeCrypto.randomUUID());
  const pins = new SnapshotRefPins(gitExecutor, storeId, base.db, writer, lock, snapshots, hostRuntime);
  const published: TurnRevertResult[] = [];
  const runtime: TurnRuntimeSnapshot[] = [];
  const deps: TurnRevertDeps = { snapshots, ranges: base.ranges, writer, store, storeId, lock,
    ...turnRevertContext(base.db, base.deps, () => runtime), publish: (result) => { published.push(result); } };
  let cwd = base.directory;
  const git = (...args: string[]) => NodeChildProcess.execFileSync("git", ["-C", cwd, ...args],
    { encoding: "utf8", env: { ...process.env, ...PIN_COMMIT_ENV }, windowsHide: true }).trim();
  git("config", "core.autocrlf", "false");
  git("config", "user.email", "");
  const write = (name: string, bytes: string | Buffer) => { NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true }); NodeFS.writeFileSync(NodePath.join(cwd, name), bytes); };
  const read = (name: string) => NodeFS.readFileSync(NodePath.join(cwd, name));
  const exists = (name: string) => NodeFS.existsSync(NodePath.join(cwd, name));
  const remove = (name: string) => NodeFS.rmSync(NodePath.join(cwd, name), { recursive: true, force: true });
  const rename = (from: string, to: string) => NodeFS.renameSync(NodePath.join(cwd, from), NodePath.join(cwd, to));
  const service = (fault?: (point: RevertFaultPoint, writes: number) => void | Promise<void>) => new TurnRevertService(deps, fault);
  async function turn(id: string, mutate: () => void, options: { attemptOf?: string; effects?: FileEffect[]; paths?: string[]; ageDays?: number } = {}) {
    const row = await base.attempt({ id, attemptOf: options.attemptOf, ageDays: options.ageDays });
    if (!row) throw new Error("Fixture snapshot missing");
    const before = await snapshots.captureRef(cwd);
    mutate();
    const after = await snapshots.captureRef(cwd);
    const paths = options.paths ?? await snapshots.getFilesChanged(cwd, before, after);
    const effects = options.effects ? JSON.stringify({ revision: 1, fileCount: options.effects.length, additions: 0, deletions: 0, effects: options.effects }) : "{}";
    base.db.prepare("UPDATE turn_snapshots SET ref_before=?, ref_after=?, files_changed=?, file_effects=?, worktree_path=? WHERE id=?")
      .run(before, after, JSON.stringify(paths), effects, cwd, row.id);
    await pins.transferToSnapshot(cwd, { id: row.id, refBefore: before, refAfter: after }, null);
    return { id: row.id, messageId: row.message_id, before, after };
  }
  async function request(messageId: string, scope: TurnRevertScope = { kind: "turn" }, instance = service()) {
    const input = { threadId: "thread", messageId, scope };
    const preview = await instance.preview(input);
    if (preview.status !== "ready") throw new Error(`Expected ready preview: ${JSON.stringify(preview)}`);
    return { ...input, previewToken: preview.previewToken, requestId: NodeCrypto.randomUUID() };
  }
  function linked() {
    write("seed", "seed\n"); git("add", "seed");
    const commit = git("commit-tree", git("write-tree"), "-m", "initial"); git("update-ref", "refs/heads/main", commit);
    const linked = NodePath.join(base.directory, "linked"); git("worktree", "add", "-b", "linked", linked);
    cwd = linked;
    base.db.prepare("UPDATE threads SET mode='worktree', worktree_path=? WHERE id='thread'").run(cwd);
  }
  return { ...base, snapshotRouterDeps: base.deps, snapshotRepo: base.snapshots, get cwd() { return cwd; }, lock, snapshots, writer, store, storeId, pins, published, runtime, deps, git, write, read, exists, remove, rename, service, turn, request, linked };
}

/** Explicit rename evidence independent of similarity heuristics. */
export function renamed(oldPath: string, path: string): FileEffect {
  return { path, oldPath, kind: "renamed", scope: "workspace", additions: 0, deletions: 0, binary: false, toolCallIds: [] };
}

/** Require an actual committed outcome before reading its receipt identity. */
export function committed(result: TurnRevertResult) {
  if (result.status !== "reverted") throw new Error(JSON.stringify(result));
  return result;
}

/** Probe symbolic-link permission once. Windows hosts may require Developer Mode or elevation. */
export function probeSymlinks(): boolean {
  const root = NodePath.resolve(process.cwd(), "../../.codex/tmp");
  NodeFS.mkdirSync(root, { recursive: true });
  const link = NodePath.join(root, `revert-symlink-probe-${NodeCrypto.randomUUID()}`);
  try { NodeFS.symlinkSync("missing-target", link); return true; }
  catch (error) { if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOSYS"].includes(String(error.code))) return false; throw error; }
  finally { if (NodeFS.lstatSync(link, { throwIfNoEntry: false })) NodeFS.unlinkSync(link); }
}
