import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { routeSnapshotRpc } from "../../transport/snapshot-rpc.js";
import { revertFixture, renamed, committed, probeSymlinks } from "./turn-revert-fixture.js";

const symlinks = probeSymlinks();
let f: Awaited<ReturnType<typeof revertFixture>>;
afterEach(async () => { if (f) await f.close(); });
const timeout = 120_000;

describe("turn revert server operation", () => {
  it("restores modified, added, removed, renamed and binary paths without changing HEAD or index; replays three clicks", async () => {
    f = await revertFixture();
    f.write("a", "before\n"); f.write("removed", "gone\n"); f.write("old", "renamed\n"); f.write("binary", Buffer.from([0, 255, 1]));
    f.git("add", "."); f.git("update-ref", "refs/heads/main", f.git("commit-tree", f.git("write-tree"), "-m", "base"));
    f.write("staged", "staged\n"); f.git("add", "staged");
    const head = f.git("rev-parse", "HEAD"), index = f.git("diff", "--cached", "--binary");
    const turn = await f.turn("one", () => { f.write("a", "after\n"); f.write("added", "new\n"); f.remove("removed"); f.rename("old", "new"); f.write("binary", Buffer.from([0, 254, 2])); });
    const service = f.service(), request = await f.request(turn.messageId);
    const first = committed(await service.apply(request));
    expect(first.receipt.content).toBe("Reverted Turn 1 · 6 files");
    expect(f.read("a")).toEqual(Buffer.from("before\n")); expect(f.exists("added")).toBe(false);
    expect(f.read("removed")).toEqual(Buffer.from("gone\n")); expect(f.read("old")).toEqual(Buffer.from("renamed\n")); expect(f.exists("new")).toBe(false);
    expect(f.read("binary")).toEqual(Buffer.from([0, 255, 1]));
    expect(f.git("rev-parse", "HEAD")).toBe(head); expect(f.git("diff", "--cached", "--binary")).toBe(index);
    expect(await service.preview(request)).toEqual({ status: "nothing_to_revert" });
    const undo = { threadId: "thread", revertId: first.revert.id, requestId: NodeCrypto.randomUUID() };
    const undone = committed(await service.undo(undo));
    expect(undone.receipt).toMatchObject({ content: "Undid revert · Turn 1",
      systemNotice: { kind: "turn-revert-undone", revertId: undone.revert.id, undoesRevertId: first.revert.id } });
    expect(f.read("a")).toEqual(Buffer.from("after\n")); expect(f.read("binary")).toEqual(Buffer.from([0, 254, 2]));
    const again = await f.request(turn.messageId), second = committed(await service.apply(again));
    expect(second.revert.id).not.toBe(first.revert.id);
    expect(await service.apply(request)).toEqual(first);
    expect(await service.undo(undo)).toEqual(undone); expect(await service.apply(again)).toEqual(second);
    expect(f.read("a")).toEqual(Buffer.from("before\n")); expect(f.published).toHaveLength(3);
    await expect(service.apply({ ...request, scope: { kind: "file", path: "a" } })).rejects.toThrow(/requestId/);
  }, timeout);

  it("reverts all retry attempts given either message and restores exact post-retry bytes with Undo", async () => {
    f = await revertFixture(); for (const name of ["a.ts", "b.ts", "c.ts"]) f.write(name, "zero\n");
    const one = await f.turn("one", () => { f.write("a.ts", "one\n"); f.write("b.ts", "one\n"); });
    const two = await f.turn("two", () => { f.write("b.ts", "two\n"); f.write("c.ts", "two\n"); }, { attemptOf: "one" });
    for (const messageId of [one.messageId, two.messageId]) {
      const service = f.service(), req = await f.request(messageId);
      expect(await service.preview(req)).toMatchObject({ status: "ready", files: expect.arrayContaining([{ path: "a.ts", action: "restore", state: "clean", binary: false }]) });
      const result = committed(await service.apply(req));
      for (const name of ["a.ts", "b.ts", "c.ts"]) expect(f.read(name)).toEqual(Buffer.from("zero\n"));
      committed(await service.undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() }));
      expect(f.read("a.ts")).toEqual(Buffer.from("one\n")); expect(f.read("b.ts")).toEqual(Buffer.from("two\n")); expect(f.read("c.ts")).toEqual(Buffer.from("two\n"));
    }
  }, timeout);

  it("ranges mark only attributed rows, distinguish outside and later turns, and validate bound range parameters", async () => {
    f = await revertFixture(); f.write("a.ts", "zero\n");
    const one = await f.turn("one", () => f.write("a.ts", "one\n"));
    const two = await f.turn("two", () => f.write("b.ts", "two\n"));
    const three = await f.turn("three", () => f.write("a.ts", "three\n"));
    const scope = { kind: "file", path: "a.ts", fromMessageId: one.messageId } satisfies import("@mcode/contracts").TurnRevertScope;
    const service = f.service(); f.write("a.ts", "hand\n");
    const req = await f.request(three.messageId, scope);
    expect(await service.preview(req)).toMatchObject({ files: [{ path: "a.ts", state: "changed_later", changedBy: "outside" }] });
    const result = committed(await service.apply(req)); expect(f.read("a.ts")).toEqual(Buffer.from("zero\n"));
    const rows = await routeSnapshotRpc("snapshot.listByThread", { threadId: "thread" }, { ...f.snapshotRouterDeps, turnRevertStore: f.store });
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id: one.id, reverted_paths: ["a.ts"] }), expect.objectContaining({ id: two.id, reverted_paths: [] }), expect.objectContaining({ id: three.id, reverted_paths: ["a.ts"] })]));
    committed(await service.undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() })); expect(f.read("a.ts")).toEqual(Buffer.from("hand\n"));
    expect(f.store.revertedPathsBySnapshot("thread")).toEqual(new Map());
    await f.turn("four", () => f.write("a.ts", "four\n"));
    expect(await service.preview(req)).toMatchObject({ files: [{ state: "changed_later", changedBy: "later_turn" }] });
    await expect(service.preview({ ...req, messageId: one.messageId, scope: { ...scope, fromMessageId: three.messageId } })).rejects.toThrow(/after/);
    await expect(service.preview({ ...req, scope: { ...scope, path: "unattributed" } })).rejects.toThrow(/attributed/);
    await expect(service.apply({ ...req, scope: { ...scope, fromMessageId: two.messageId } })).rejects.toThrow(/requestId/);
  }, timeout);

  it.each(["turns", "attempts", "one-attempt", "git-fallback"])("closes rename chains for %s and either endpoint", async (kind) => {
    f = await revertFixture(); f.write("a.ts", "original\n");
    const one = await f.turn("one", () => { f.rename("a.ts", "b.ts"); if (kind === "one-attempt" || kind === "git-fallback") f.rename("b.ts", "c.ts"); },
      { effects: kind === "git-fallback" ? undefined : kind === "one-attempt" ? [renamed("a.ts", "b.ts"), renamed("b.ts", "c.ts")] : [renamed("a.ts", "b.ts")] });
    const last = kind === "turns" || kind === "attempts" ? await f.turn("three", () => f.rename("b.ts", "c.ts"),
      { effects: [renamed("b.ts", "c.ts")], ...(kind === "attempts" ? { attemptOf: "one" } : {}) }) : one;
    for (const endpoint of ["a.ts", "c.ts"]) {
      const scope = { kind: "file", path: endpoint, ...(kind === "turns" ? { fromMessageId: one.messageId } : {}) } satisfies import("@mcode/contracts").TurnRevertScope;
      const service = f.service(), req = await f.request(last.messageId, scope);
      expect(await service.preview(req)).toMatchObject({ files: expect.arrayContaining([
        expect.objectContaining({ path: "a.ts", action: "recreate" }), expect.objectContaining({ path: "c.ts", action: "delete", previousPath: "a.ts" }),
      ]) });
      f.write("a.ts", "outside edit\n");
      expect(await service.apply(req)).toMatchObject({ status: "stale" }); f.remove("a.ts");
      const result = committed(await service.apply(req)); expect(f.read("a.ts")).toEqual(Buffer.from("original\n")); expect(f.exists("b.ts")).toBe(false); expect(f.exists("c.ts")).toBe(false);
      committed(await service.undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() }));
      expect(f.read("c.ts")).toEqual(Buffer.from("original\n")); expect(f.exists("a.ts")).toBe(false);
    }
    if (kind !== "turns") {
      committed(await f.service().apply(await f.request(last.messageId)));
      expect(f.read("a.ts")).toEqual(Buffer.from("original\n")); expect(f.exists("b.ts")).toBe(false); expect(f.exists("c.ts")).toBe(false);
    }
  }, timeout);

  it("rejects incomplete retry and range evidence", async () => {
    f = await revertFixture(); f.write("a", "zero");
    const one = await f.turn("one", () => f.write("a", "one"), { ageDays: 31 });
    const two = await f.turn("two", () => f.write("a", "two"), { attemptOf: "one" });
    await f.snapshotRepo.deleteExpired(30);
    for (const scope of [{ kind: "turn" }, { kind: "file", path: "a" }, { kind: "file", path: "a", fromMessageId: one.messageId }] satisfies import("@mcode/contracts").TurnRevertScope[]) {
      expect(await f.service().preview({ threadId: "thread", messageId: two.messageId, scope })).toEqual({ status: "unavailable", reason: "snapshot_missing" });
      expect(await f.service().apply({ threadId: "thread", messageId: two.messageId, scope, previewToken: "expired", requestId: NodeCrypto.randomUUID() }))
        .toEqual({ status: "unavailable", reason: "snapshot_missing" });
    }
    expect(f.read("a")).toEqual(Buffer.from("two"));
    const last = await f.turn("last", () => f.write("last", "last"));
    expect(await f.service().preview({ threadId: "thread", messageId: last.messageId, scope: { kind: "file", path: "a", fromMessageId: one.messageId } }))
      .toEqual({ status: "unavailable", reason: "snapshot_missing" });
  }, timeout);

  it.each(["file-to-folder", "folder-to-file"])("restores and undoes %s; refuses an unrelated folder child", async (direction) => {
    f = await revertFixture();
    if (direction === "file-to-folder") f.write("node", "file\n"); else f.write("node/child", "child\n");
    const turn = await f.turn("one", () => { f.remove("node"); if (direction === "file-to-folder") f.write("node/child", "new child\n"); else f.write("node", "new file\n"); });
    const result = committed(await f.service().apply(await f.request(turn.messageId)));
    expect(f.read(direction === "file-to-folder" ? "node" : "node/child")).toEqual(Buffer.from(direction === "file-to-folder" ? "file\n" : "child\n"));
    committed(await f.service().undo({ threadId: "thread", revertId: result.revert.id, requestId: NodeCrypto.randomUUID() }));
    expect(f.read(direction === "file-to-folder" ? "node/child" : "node")).toEqual(Buffer.from(direction === "file-to-folder" ? "new child\n" : "new file\n"));
    if (direction === "file-to-folder") {
      f.write("node/unrelated", "keep\n");
      expect(await f.service().preview({ threadId: "thread", messageId: turn.messageId, scope: { kind: "turn" } })).toMatchObject({ skipped: [{ path: "node", reason: "folder_in_the_way" }] });
      expect(await f.service().apply(await f.request(turn.messageId))).toMatchObject({ status: "stale", preview: { status: "nothing_to_revert" } });
      expect(f.read("node/child")).toEqual(Buffer.from("new child\n"));
      expect(f.read("node/unrelated")).toEqual(Buffer.from("keep\n"));
    }
  }, timeout);

  it("reports ignored paths and rejects raw content changes after preview", async () => {
    f = await revertFixture(); f.write(".gitignore", "ignored\n"); f.write("a", "zero\n");
    const turn = await f.turn("one", () => { f.write("a", "one\n"); f.write("ignored", "private\n"); }, { paths: ["a", "ignored"] });
    const req = await f.request(turn.messageId);
    expect(await f.service().preview(req)).toMatchObject({ skipped: [{ path: "ignored", reason: "ignored" }] });
    f.write("a", "hand\n"); expect(await f.service().apply(req)).toMatchObject({ status: "stale", preview: { status: "ready" } });
    expect(f.read("a")).toEqual(Buffer.from("hand\n")); expect(f.read("ignored")).toEqual(Buffer.from("private\n"));
    committed(await f.service().apply(await f.request(turn.messageId)));
    expect(f.read("a")).toEqual(Buffer.from("zero\n")); expect(f.read("ignored")).toEqual(Buffer.from("private\n"));
  }, timeout);

  it("reverts a force-added tracked file under an ignored directory", async () => {
    f = await revertFixture(); f.write(".gitignore", "dist/\n"); f.write("dist/keep.js", "before\n");
    f.git("add", "-f", "dist/keep.js");
    f.git("add", ".gitignore");
    f.git("update-ref", "refs/heads/main", f.git("commit-tree", f.git("write-tree"), "-m", "tracked build output"));
    const turn = await f.turn("one", () => f.write("dist/keep.js", "after\n"));
    const request = await f.request(turn.messageId);
    expect(await f.service().preview(request)).toMatchObject({ skipped: [], files: [{ path: "dist/keep.js", state: "clean", action: "restore" }] });
    const result = committed(await f.service().apply(request));
    expect(result.receipt.content).toBe("Reverted Turn 1 · 1 file");
    expect(f.read("dist/keep.js")).toEqual(Buffer.from("before\n"));
  }, timeout);

  it.skipIf(!symlinks)("a file-to-symlink change invalidates preview", async () => {
    f = await revertFixture(); f.write("a", "zero\n"); const turn = await f.turn("one", () => f.write("a", "one\n"));
    const req = await f.request(turn.messageId); f.remove("a"); NodeFS.symlinkSync("elsewhere", NodePath.join(f.cwd, "a"));
    expect(await f.service().apply(req)).toMatchObject({ status: "stale" }); expect(NodeFS.readlinkSync(NodePath.join(f.cwd, "a"))).toBe("elsewhere");
  }, timeout);

  it.skipIf(process.platform === "win32")("executable bit alone invalidates preview", async () => {
    f = await revertFixture(); f.git("config", "core.fileMode", "true"); f.write("a", "zero\n");
    const turn = await f.turn("one", () => f.write("a", "one\n")), req = await f.request(turn.messageId);
    NodeFS.chmodSync(NodePath.join(f.cwd, "a"), 0o755); expect(await f.service().apply(req)).toMatchObject({ status: "stale" });
  }, timeout);
});
