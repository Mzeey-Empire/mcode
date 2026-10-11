import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRuntime } from "@mcode/shared/node/host-runtime";
import { TurnRevertFaultStop, TurnRevertService } from "../turn-revert-service.js";
import { RepositoryGitMutationLock } from "../../../git/repository-git-mutation-lock.js";
import { RealGitExecutor } from "../../../git/execution/real-git-executor.js";
import { SnapshotService } from "../../snapshots/snapshot-service.js";
import { absentState, samePathState } from "../../snapshots/snapshot-raw-state.js";
import { revertFixture, committed, renamed, probeSymlinks } from "./turn-revert-fixture.js";

const symlinks = probeSymlinks();
const timeout = 180_000;
let f: Awaited<ReturnType<typeof revertFixture>>;
afterEach(async () => { if (f) await f.close(); });

describe("raw revert recovery", () => {
  it.each(["afterPrepare", "afterWrite", "commit"] satisfies import("../turn-revert-service.js").RevertFaultPoint[])("recovers simulated death at %s once from the prepared journal", async (stop) => {
    f = await revertFixture(); f.write("a", "before\n"); f.write("b", "before b\n");
    const turn = await f.turn("one", () => { f.write("a", "after\n"); f.write("b", "after b\n"); });
    const request = await f.request(turn.messageId);
    const service = f.service((point, writes) => { if (point === stop && (point !== "afterWrite" || writes === 1)) throw new TurnRevertFaultStop(); });
    await expect(service.apply(request)).rejects.toBeInstanceOf(TurnRevertFaultStop);
    const row = f.store.byRequest(request.requestId); expect(row?.state).toBe("prepared");
    if (!row?.recoveryRef) throw new Error("Missing recovery pin");
    expect(f.git("cat-file", "-t", row.recoveryRef)).toBe("commit"); expect(row.files.map((file) => file.path)).toEqual(["a", "b"]);
    for (const file of row.files) { expect(file.pre.kind).toBe("file"); expect(file.planned?.kind).toBe("file"); expect(file.pre.sha256).not.toBe(file.planned?.sha256); }
    if (stop === "afterPrepare") { expect(f.read("a")).toEqual(Buffer.from("after\n")); expect(f.read("b")).toEqual(Buffer.from("after b\n")); }
    await f.service().recoverUnfinished(); await f.service().recoverUnfinished();
    expect(f.read("a")).toEqual(Buffer.from("after\n")); expect(f.read("b")).toEqual(Buffer.from("after b\n")); expect(f.store.get(row.id)?.state).toBe("rolled_back");
    expect(f.db.query("SELECT count(*) AS n FROM messages WHERE json_extract(system_notice, '$.kind') = 'turn-revert-interrupted'").get()).toEqual({ n: 1 });
  }, timeout);

  it.each(["afterPrepare", "afterWrite", "commit"] satisfies import("../turn-revert-service.js").RevertFaultPoint[])("rolls back a thrown error at %s", async (stop) => {
    f = await revertFixture(); f.write("a", "before\n"); const turn = await f.turn("one", () => f.write("a", "after\n"));
    const result = await f.service((point) => { if (point === stop) throw new Error("injected failure"); }).apply(await f.request(turn.messageId));
    expect(result).toMatchObject({ status: "failed", outcome: "rolled_back", paths: [] }); expect(f.read("a")).toEqual(Buffer.from("after\n"));
    expect(f.db.query("SELECT count(*) AS n FROM messages WHERE json_extract(system_notice, '$.kind') IN ('turn-reverted', 'turn-revert-undone', 'turn-revert-interrupted')").get()).toEqual({ n: 0 });
    expect(f.published).toEqual([]);
  }, timeout);

  it("writes the interrupted receipt only when startup retries a failed runtime rollback", async () => {
    f = await revertFixture(); f.write("a", "before\n");
    const turn = await f.turn("one", () => f.write("a", "after\n"));
    const request = await f.request(turn.messageId);
    const result = await f.service((point) => {
      if (point === "afterWrite") { f.write("a", "external\n"); throw new Error("injected failure"); }
    }).apply(request);
    expect(result).toMatchObject({ status: "failed", outcome: "recovery_failed", paths: ["a"] });
    expect(f.store.byRequest(request.requestId)?.receiptMessageId).toBeNull();
    expect(f.published).toEqual([]);
    await f.service().recoverUnfinished();
    await f.service().recoverUnfinished();
    expect(f.read("a")).toEqual(Buffer.from("external\n"));
    expect(f.store.byRequest(request.requestId)?.state).toBe("recovery_failed");
    expect(f.db.query("SELECT content FROM messages WHERE json_extract(system_notice, '$.kind') = 'turn-revert-interrupted'").all())
      .toEqual([{ content: "Revert of Turn 1 was interrupted. 1 file could not be put back: a" }]);
  }, timeout);

  it("startup retry of a failed revert leaves paths a later committed revert wrote", async () => {
    f = await revertFixture(); f.write("a", "before a\n"); f.write("b", "before b\n");
    const turn = await f.turn("one", () => { f.write("a", "after a\n"); f.write("b", "after b\n"); });
    const first = await f.request(turn.messageId);
    const failed = await f.service((point, writes) => {
      if (point === "afterWrite" && writes === 1) { f.write("b", "edited b\n"); throw new Error("injected failure"); }
    }).apply(first);
    expect(failed).toMatchObject({ status: "failed", outcome: "recovery_failed", paths: ["b"] });
    expect(f.read("a")).toEqual(Buffer.from("after a\n"));
    committed(await f.service().apply(await f.request(turn.messageId)));
    expect(f.read("a")).toEqual(Buffer.from("before a\n")); expect(f.read("b")).toEqual(Buffer.from("before b\n"));
    await f.service().recoverUnfinished();
    expect(f.read("a")).toEqual(Buffer.from("before a\n")); expect(f.read("b")).toEqual(Buffer.from("before b\n"));
    expect(f.store.byRequest(first.requestId)?.state).toBe("rolled_back");
  }, timeout);

  it("startup unwinds an interrupted retry before the failed revert it retried", async () => {
    f = await revertFixture(); f.write("a", "before a\n"); f.write("b", "before b\n");
    const turn = await f.turn("one", () => { f.write("a", "after a\n"); f.write("b", "after b\n"); });
    const first = await f.request(turn.messageId);
    const failed = await f.service((point, writes) => {
      if (point === "afterWrite" && writes === 1) { f.write("b", "edited b\n"); throw new Error("injected failure"); }
    }).apply(first);
    expect(failed).toMatchObject({ status: "failed", outcome: "recovery_failed", paths: ["b"] });
    const retry = await f.request(turn.messageId);
    await expect(f.service((point) => { if (point === "commit") throw new TurnRevertFaultStop(); }).apply(retry)).rejects.toBeInstanceOf(TurnRevertFaultStop);
    expect(f.read("b")).toEqual(Buffer.from("before b\n"));
    await f.service().recoverUnfinished();
    expect(f.read("a")).toEqual(Buffer.from("after a\n")); expect(f.read("b")).toEqual(Buffer.from("edited b\n"));
    expect(f.store.byRequest(retry.requestId)?.state).toBe("rolled_back");
    expect(f.store.byRequest(first.requestId)).toMatchObject({ state: "recovery_failed", failure: { paths: ["b"] } });
  }, timeout);

  it("a replay that settles a prepared row writes no receipt", async () => {
    f = await revertFixture(); f.write("a", "before\n"); const turn = await f.turn("one", () => f.write("a", "after\n"));
    const request = await f.request(turn.messageId);
    await expect(f.service((point) => { if (point === "afterPrepare") throw new TurnRevertFaultStop(); }).apply(request)).rejects.toBeInstanceOf(TurnRevertFaultStop);
    expect(await f.service().apply(request)).toMatchObject({ status: "failed", outcome: "rolled_back", paths: [] });
    expect(f.db.query("SELECT count(*) AS n FROM messages WHERE json_extract(system_notice, '$.kind') = 'turn-revert-interrupted'").get()).toEqual({ n: 0 });
  }, timeout);

  it.each(["captureRaw", "planCheckout", "pinRecovery"] satisfies import("../turn-revert-service.js").RevertFaultPoint[])("a %s failure leaves files unchanged and no prepared row", async (stop) => {
    f = await revertFixture(); f.write("a", "before\n"); const turn = await f.turn("one", () => f.write("a", "after\n"));
    const request = await f.request(turn.messageId);
    expect(await f.service((point) => { if (point === stop) throw new Error("injected failure"); }).apply(request)).toEqual({ status: "failed", outcome: "unchanged", paths: [], detail: "injected failure" });
    expect(f.store.byRequest(request.requestId)).toBeNull(); expect(f.read("a")).toEqual(Buffer.from("after\n"));
  }, timeout);

  it.each(["CRLF", "mixed", "filter"])("planned %s bytes equal checkout and Undo is byte-exact", async (kind) => {
    f = await revertFixture(); configureTextFixture(kind);
    f.write("a.txt", "before\n# baseline\n");
    const after = kind === "mixed" ? "after\r\n# after\nend\r\n" : "after\n# after\n";
    const turn = await f.turn("one", () => f.write("a.txt", after));
    // Independent oracle: an actual checkout into the original worktree with an isolated index.
    const index = NodePath.join(f.cwd, ".git", "oracle-index");
    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = index;
    let expected: Buffer;
    try { f.git("read-tree", turn.before); f.git("checkout-index", "--force", "--", "a.txt"); expected = f.read("a.txt"); }
    finally { if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous; if (NodeFS.existsSync(index)) NodeFS.unlinkSync(index); }
    f.write("a.txt", after);
    const result = committed(await f.service().apply(await f.request(turn.messageId)));
    expect(f.read("a.txt")).toEqual(expected);
    const row = f.store.get(result.revert.id); if (!row) throw new Error("Missing row");
    const current = await f.snapshots.workingTreeState(f.cwd, ["a.txt"]), actual = current.get("a.txt"), planned = row.files[0]?.planned;
    if (!actual || !planned) throw new Error("Missing state"); expect(samePathState(actual, planned)).toBe(true);
    f.git("gc", "--prune=now", "--quiet");
    committed(await f.service().undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() }));
    expect(f.read("a.txt")).toEqual(Buffer.from(after));
    const again = committed(await f.service().apply(await f.request(turn.messageId))); f.write("a.txt", "newer\n");
    expect(await f.service().undo({ threadId: "thread", revertId: again.revert.id, requestId: NodeCrypto.randomUUID() })).toMatchObject({ status: "stale" });
    expect(f.read("a.txt")).toEqual(Buffer.from("newer\n"));
  }, timeout);

  it.each(["outside", "CRLF", "filter", "missing-ref", "missing-planned"])("leaves unprovable %s recovery state alone", async (kind) => {
    f = await revertFixture(); configureTextFixture(kind); f.write("a.txt", "before\n# baseline\n");
    const turn = await f.turn("one", () => f.write("a.txt", "after\n# after\n")), request = await f.request(turn.messageId);
    await expect(f.service((point) => { if (point === "afterWrite") throw new TurnRevertFaultStop(); }).apply(request)).rejects.toBeInstanceOf(TurnRevertFaultStop);
    const row = f.store.byRequest(request.requestId); if (!row?.recoveryRef) throw new Error("Missing prepared row");
    const changed = kind === "CRLF" ? "before\n# baseline\n" : kind === "filter" ? "before\n# changed comment\n" : "external edit\n";
    if (kind === "missing-ref") f.git("update-ref", "-d", row.recoveryRef);
    else if (kind === "missing-planned") f.db.prepare("UPDATE turn_reverts SET files=json_remove(files, '$[0].planned') WHERE id=?").run(row.id);
    else f.write("a.txt", changed);
    const expected = f.read("a.txt"); await f.service().recoverUnfinished();
    expect(f.read("a.txt")).toEqual(expected); expect(f.store.get(row.id)).toMatchObject({ state: "recovery_failed", failure: { paths: ["a.txt"] }, recoveryRef: row.recoveryRef });
    if (kind !== "missing-ref") expect(f.git("cat-file", "-t", row.recoveryRef)).toBe("commit");
  }, timeout);

  it("recovers a cross-turn rename chain byte-exact", async () => {
    f = await revertFixture(); f.write("a.ts", "original\n");
    const one = await f.turn("one", () => f.rename("a.ts", "b.ts"), { effects: [renamed("a.ts", "b.ts")] });
    const three = await f.turn("three", () => f.rename("b.ts", "c.ts"), { effects: [renamed("b.ts", "c.ts")] });
    const request = await f.request(three.messageId, { kind: "file", path: "c.ts", fromMessageId: one.messageId });
    await expect(f.service((point, n) => { if (point === "afterWrite" && n === 1) throw new TurnRevertFaultStop(); }).apply(request)).rejects.toBeInstanceOf(TurnRevertFaultStop);
    expect(f.store.byRequest(request.requestId)?.files.map((file) => file.path)).toEqual(["a.ts", "c.ts"]);
    await f.service().recoverUnfinished(); expect(f.read("c.ts")).toEqual(Buffer.from("original\n")); expect(f.exists("a.ts")).toBe(false); expect(f.exists("b.ts")).toBe(false);
    expect(f.db.query("SELECT count(*) AS n FROM messages WHERE json_extract(system_notice, '$.kind') = 'turn-revert-interrupted'").get()).toEqual({ n: 1 });
  }, timeout);

  it("Undo survives gc in a linked worktree with no user.email; sweep owns only this store and retains unfinished pins", async () => {
    f = await revertFixture(); f.linked(); f.write("a", "before\n");
    const turn = await f.turn("one", () => f.write("a", "after\n")); const result = committed(await f.service().apply(await f.request(turn.messageId)));
    f.git("gc", "--prune=now", "--quiet"); committed(await f.service().undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() })); expect(f.read("a")).toEqual(Buffer.from("after\n"));
    const rollbackRequest = await f.request(turn.messageId);
    expect(await f.service((point) => { if (point === "afterPrepare") throw new Error("rollback"); }).apply(rollbackRequest)).toMatchObject({ status: "failed", outcome: "rolled_back" });
    const request = await f.request(turn.messageId);
    await expect(f.service((point) => { if (point === "afterPrepare") throw new TurnRevertFaultStop(); }).apply(request)).rejects.toBeInstanceOf(TurnRevertFaultStop);
    const prepared = f.store.byRequest(request.requestId); if (!prepared?.recoveryRef) throw new Error("Missing prepared");
    const orphan = `refs/mcode/${f.storeId}/reverts/orphan`, other = `refs/mcode/${NodeCrypto.randomUUID()}/reverts/other`;
    vi.stubEnv("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z");
    let oldCommit: string;
    try { oldCommit = f.git("commit-tree", `${prepared.recoveryRef}^{tree}`, "-m", "old orphan"); }
    finally { vi.unstubAllEnvs(); }
    f.git("update-ref", orphan, oldCommit); f.git("update-ref", other, oldCommit);
    f.db.prepare("UPDATE turn_reverts SET created_at='2000-01-01T00:00:00.000Z'").run();
    await f.pins.sweep({ isThreadLive: () => true });
    expect(f.git("for-each-ref", "--format=%(refname)", orphan)).toBe(""); expect(f.git("cat-file", "-t", other)).toBe("commit");
    expect(f.git("cat-file", "-t", prepared.recoveryRef)).toBe("commit"); expect(f.store.get(result.revert.id)?.recoveryRef).toBeNull();
    expect(f.store.byRequest(rollbackRequest.requestId)?.recoveryRef).toBeNull();
    f.db.prepare("UPDATE turn_reverts SET state='recovery_failed' WHERE id=?").run(prepared.id);
    await f.pins.sweep({ isThreadLive: () => true }); expect(f.git("cat-file", "-t", prepared.recoveryRef)).toBe("commit");
  }, timeout);

  it("busy covers another active thread and a send waits until the reverted baseline exists", async () => {
    f = await revertFixture(); f.write("a", "before\n"); const turn = await f.turn("one", () => f.write("a", "after\n"));
    f.db.prepare("INSERT INTO threads(id,workspace_id,title,branch) VALUES ('other','ws','other','main')").run();
    f.db.prepare("INSERT INTO canonical_agent_threads(id,workspace_id,root_thread_id,provider_id,activity_state,created_at,updated_at) VALUES ('other','ws','other','codex','Idle','now','now')").run();
    f.db.prepare("INSERT INTO canonical_agent_turns(id,thread_id,execution_id,status,trigger_json,permission_mode,created_at,updated_at) VALUES ('busy','other','busy-exec','Running','{}','supervised','now','now')").run();
    expect(await f.service().preview({ threadId: "thread", messageId: turn.messageId, scope: { kind: "turn" } })).toEqual({ status: "busy", reason: "turn_running" });
    f.db.prepare("UPDATE canonical_agent_turns SET status='Completed' WHERE id='busy'").run();
    f.db.prepare("INSERT INTO thread_startups(startup_id,workspace_id,thread_id,kind,state,phase,steps_json,transcript_json,revision) VALUES ('starting','ws','other','direct','running','agent','[]','[]',1)").run();
    expect(await f.service().preview({ threadId: "thread", messageId: turn.messageId, scope: { kind: "turn" } })).toEqual({ status: "busy", reason: "turn_running" });
    f.db.prepare("UPDATE thread_startups SET state='completed' WHERE startup_id='starting'").run();
    f.db.prepare("INSERT INTO threads(id,workspace_id,title,branch,mode) VALUES ('missing-worktree','ws','missing','main','worktree')").run();
    let release = () => {}, entered = () => {};
    const pause = new Promise<void>((resolve) => { release = resolve; }), prepared = new Promise<void>((resolve) => { entered = resolve; });
    const service = f.service(async (point) => { if (point === "afterPrepare") { entered(); await pause; } });
    const request = await f.request(turn.messageId), applying = service.apply(request); await prepared;
    expect(await service.preview(request)).toEqual({ status: "busy", reason: "revert_running" });
    const replay = service.apply(request);
    let captured = false;
    const baseline = f.snapshots.captureRef(f.cwd).then((ref) => { captured = true; return ref; });
    await Promise.resolve(); expect(captured).toBe(false); release(); const applied = committed(await applying);
    expect(await replay).toEqual(applied); expect(f.published).toHaveLength(1);
    expect(await baseline).toBe(turn.before); expect(f.read("a")).toEqual(Buffer.from("before\n"));
  }, timeout);

  it.each(["apply", "undo"])("serializes %s and baseline capture under a symlinked cwd with POSIX lock keys", async (operation) => {
    f = await revertFixture(); f.write("a", "before\n");
    const turn = await f.turn("one", () => f.write("a", "after\n"));
    const alias = `${f.cwd}-alias`;
    NodeFS.symlinkSync(f.cwd, alias, "junction");
    let release = () => {}, entered = () => {};
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const prepared = new Promise<void>((resolve) => { entered = resolve; });
    try {
      f.db.prepare("UPDATE workspaces SET path=? WHERE id='ws'").run(alias);
      f.db.prepare("UPDATE turn_snapshots SET worktree_path=?").run(alias);
      const lock = new RepositoryGitMutationLock({ ...hostRuntime, platform: "linux" });
      const snapshots = new SnapshotService(new RealGitExecutor(), lock);
      const deps = { ...f.deps, lock, snapshots };
      const initial = new TurnRevertService(deps);
      const request = await f.request(turn.messageId, { kind: "turn" }, initial);
      const forward = operation === "undo" ? committed(await initial.apply(request)) : null;
      const service = new TurnRevertService(deps, async (point) => { if (point === "afterPrepare") { entered(); await pause; } });
      const applying = forward
        ? service.undo({ threadId: "thread", revertId: forward.revert.id, requestId: NodeCrypto.randomUUID() })
        : service.apply(request);
      await prepared;
      expect(await service.preview(request)).toEqual({ status: "busy", reason: "revert_running" });
      let captured = false;
      const baseline = snapshots.captureRef(alias).then((ref) => { captured = true; return ref; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(captured).toBe(false);
      release(); committed(await applying);
      expect(await baseline).toBe(operation === "apply" ? turn.before : turn.after);
    } finally { release(); NodeFS.unlinkSync(alias); }
  }, timeout);

  it.skipIf(!symlinks)("restores symlink targets exactly and refuses a parent symlink escaping cwd", async () => {
    f = await revertFixture(); f.git("config", "core.symlinks", "true");
    NodeFS.symlinkSync("before-target", NodePath.join(f.cwd, "link"));
    const turn = await f.turn("one", () => { f.remove("link"); NodeFS.symlinkSync("after-target", NodePath.join(f.cwd, "link")); });
    const result = committed(await f.service().apply(await f.request(turn.messageId))); expect(NodeFS.readlinkSync(NodePath.join(f.cwd, "link"))).toBe("before-target");
    committed(await f.service().undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() })); expect(NodeFS.readlinkSync(NodePath.join(f.cwd, "link"))).toBe("after-target");
    await expect(f.snapshots.captureRaw(f.cwd, ["../escape"])).rejects.toThrow(/Invalid/);
    const external = NodeFS.mkdtempSync(NodePath.join(NodePath.dirname(f.cwd), "revert-external-"));
    try {
      NodeFS.writeFileSync(NodePath.join(external, "protected"), "untouched\n");
      NodeFS.symlinkSync(external, NodePath.join(f.cwd, "escape"), "junction");
      await expect(f.snapshots.restoreRaw(f.cwd, NodeCrypto.randomUUID(), [{ path: "escape/protected", state: absentState() }])).rejects.toThrow(/escapes/);
      expect(NodeFS.readFileSync(NodePath.join(external, "protected"))).toEqual(Buffer.from("untouched\n"));
    } finally { NodeFS.rmSync(external, { recursive: true, force: true }); }
  }, timeout);

  it.skipIf(process.platform === "win32")("restores executable mode and Undo restores the original mode", async () => {
    f = await revertFixture(); f.git("config", "core.fileMode", "true"); f.write("a", "before\n"); NodeFS.chmodSync(NodePath.join(f.cwd, "a"), 0o755);
    const turn = await f.turn("one", () => { f.write("a", "after\n"); NodeFS.chmodSync(NodePath.join(f.cwd, "a"), 0o644); });
    const result = committed(await f.service().apply(await f.request(turn.messageId))); expect(NodeFS.statSync(NodePath.join(f.cwd, "a")).mode & 0o777).toBe(0o755);
    committed(await f.service().undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() })); expect(NodeFS.statSync(NodePath.join(f.cwd, "a")).mode & 0o777).toBe(0o644);
  }, timeout);
});

function configureTextFixture(kind: string) {
  if (kind === "CRLF") f.git("config", "core.autocrlf", "true");
  if (kind === "filter") {
    f.write(".gitattributes", "*.txt filter=comments\n");
    f.git("config", "filter.comments.clean", "sed '/^#/d'"); f.git("config", "filter.comments.smudge", "sed '$a\\# smudged'");
    f.git("config", "filter.comments.required", "true");
  }
}
