import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnSnapshotSchema } from "@mcode/contracts";
import { routeSnapshotRpc } from "../snapshot-rpc.js";
import { createSnapshotRangeFixture } from "../../snapshots/__tests__/turn-snapshot-range-fixture.js";
import { SnapshotService } from "../../snapshots/snapshot-service.js";
import { FakeGitExecutor } from "../../../git/execution/fake-git-executor.js";

describe("snapshot RPC whole-turn evidence", { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotRangeFixture>>;
  beforeEach(async () => { fixture = await createSnapshotRangeFixture(); });
  afterEach(async () => { await fixture.close(); });

  it("skips empty refs in cumulative reads but reports nonempty missing refs as pruned", async () => {
    await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    fixture.db.prepare("UPDATE turn_snapshots SET ref_before = ''").run();
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiffStats", { threadId: "thread" }, fixture.deps))
      .toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiff", { threadId: "thread" }, fixture.deps)).toBe("");
    await fixture.attempt({ id: "two", edits: { "b.ts": "b\n" } });
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiffStats", { threadId: "thread" }, fixture.deps))
      .toMatchObject({ status: "ready", comparison: { files: [{ path: "b.ts" }], additions: 1, deletions: 0 } });
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiff", { threadId: "thread" }, fixture.deps)).toContain("+b");
    fixture.db.prepare("UPDATE turn_snapshots SET ref_before = ? WHERE message_id = 'message-two'").run("0".repeat(40));
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiffStats", { threadId: "thread" }, fixture.deps))
      .toEqual({ status: "unavailable", reason: "snapshot-pruned" });
  });

  it("reports a cumulative range above the Review file bound as too many files", async () => {
    await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    vi.spyOn(fixture.deps.snapshotService, "getDiffStats").mockResolvedValue(
      Array.from({ length: 10_001 }, (_, index) => ({ filePath: `file-${index}.ts`, additions: 1, deletions: 0, changeType: "modified" as const })),
    );
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiffStats", { threadId: "thread" }, fixture.deps))
      .toEqual({ status: "too-many-files", fileCount: 10_001, limit: 10_000 });
  });

  it.each([
    { error: Object.assign(new Error("Git command timed out after 5000 ms"), { killed: true, stderr: "" }), kind: "timeout", detail: "Git command timed out after 5000 ms" },
    { error: Object.assign(new Error("exit 128"), { stderr: "fatal: not a git repository" }), kind: "git-error", detail: "fatal: not a git repository" },
  ])("reports ref validation $kind instead of pruned evidence", async ({ error, kind, detail }) => {
    const row = await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    if (!row) throw new Error("Fixture snapshot missing");
    const executor = new FakeGitExecutor();
    executor.setResponse(["cat-file", "-t", row.ref_before], error);
    fixture.deps.snapshotService = new SnapshotService(executor);
    expect(await routeSnapshotRpc("snapshot.getDiffStats", { snapshotId: row.id }, fixture.deps))
      .toMatchObject({ status: "failed", failure: { kind, detail } });
    expect(await routeSnapshotRpc("snapshot.getDiff", { snapshotId: row.id }, fixture.deps))
      .toMatchObject({ status: "failed", failure: { kind, detail } });
  });

  it("validates the checkout even when the requested file is unattributed", async () => {
    const row = await fixture.attempt({ id: "one" });
    if (!row) throw new Error("Fixture snapshot missing");
    fixture.db.prepare("UPDATE turn_snapshots SET worktree_path = ?").run(fixture.directory + "/missing");
    expect(await routeSnapshotRpc("snapshot.getDiff", { snapshotId: row.id, filePath: "unattributed.ts" }, fixture.deps))
      .toMatchObject({ status: "failed", failure: { kind: "worktree-missing" } });
  });

  it("carries the range count and omits all rows of an incomplete turn", async () => {
    await fixture.attempt({ id: "one", status: "Errored", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "two", attemptOf: "one", edits: { "b.ts": "b\n" } });
    const rows = TurnSnapshotSchema().array().parse(await routeSnapshotRpc("snapshot.listByThread", { threadId: "thread" }, fixture.deps));
    expect(rows.map((row) => [row.message_id, row.attempt_count])).toEqual([["message-one", 2], ["message-two", 2]]);
    fixture.db.prepare("DELETE FROM turn_snapshots WHERE message_id = ?").run("message-one");
    expect(await routeSnapshotRpc("snapshot.listByThread", { threadId: "thread" }, fixture.deps)).toEqual([]);
    expect(await routeSnapshotRpc("snapshot.getCumulativeDiffStats", { threadId: "thread" }, fixture.deps))
      .toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
  });
});
