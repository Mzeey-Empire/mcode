import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewComparisonResultSchema, TurnSnapshotSchema } from "@mcode/contracts";
import { routeTurnDiffRpc } from "../../transport/turn-diff-rpc.js";
import { routeSnapshotRpc } from "../../transport/snapshot-rpc.js";
import { createSnapshotRangeFixture } from "./turn-snapshot-range-fixture.js";

const PATCH = "diff --git a/c.ts b/c.ts\nnew file mode 100644\n--- /dev/null\n+++ b/c.ts\n@@ -0,0 +1 @@\n+c\n";

describe("whole-turn snapshot ranges with real Git", { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotRangeFixture>>;
  beforeEach(async () => { fixture = await createSnapshotRangeFixture(); });
  afterEach(async () => { await fixture.close(); });

  async function comparison(messageId: string) {
    const result = ReviewComparisonResultSchema().parse(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId }, fixture.deps));
    if (result.status !== "ready") throw new Error(JSON.stringify(result));
    return result.comparison;
  }

  it("reads either attempt and either snapshot from the first baseline, ignoring the final native patch", async () => {
    const first = await fixture.attempt({ id: "first", status: "Errored", edits: { "a.ts": "a\n", "b.ts": "b\n" } });
    const last = await fixture.attempt({ id: "last", attemptOf: "first", edits: { "b.ts": "b\nsecond\n", "c.ts": "c\n" } });
    fixture.native("last", PATCH);
    const expected = [
      { filePath: "a.ts", changeType: "added", additions: 1, deletions: 0 },
      { filePath: "b.ts", changeType: "added", additions: 2, deletions: 0 },
      { filePath: "c.ts", changeType: "added", additions: 1, deletions: 0 },
    ];
    for (const messageId of ["message-first", "message-last"]) {
      const result = await comparison(messageId);
      expect(result.files.map((file) => ({ filePath: file.path, changeType: file.changeType, additions: file.additions, deletions: file.deletions }))).toEqual(expected);
      expect(result.additions).toBe(4);
      expect(result.deletions).toBe(0);
      expect(result.turnDiff?.source).toBe("git");
      expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: "thread", comparisonId: result.turnDiff!.id, filePath: "a.ts" }, fixture.deps)).toContain("+a");
    }
    for (const row of [first, last]) {
      if (!row) throw new Error("Fixture snapshot missing");
      expect(await routeSnapshotRpc("snapshot.getDiffStats", { snapshotId: row.id }, fixture.deps)).toEqual(expected);
    }
    const rows = await routeSnapshotRpc("snapshot.listByThread", { threadId: "thread" }, fixture.deps);
    expect(TurnSnapshotSchema().array().parse(rows).map((row) => [row.message_id, row.attempt_count])).toEqual([["message-first", 2], ["message-last", 2]]);
  });

  it("keeps the first baseline after two failures", async () => {
    await fixture.attempt({ id: "one", status: "Errored", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "two", attemptOf: "one", status: "Errored", edits: { "b.ts": "b\n" } });
    await fixture.attempt({ id: "three", attemptOf: "one", edits: { "c.ts": "c\n" } });
    expect((await comparison("message-two")).files.map((file) => file.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(fixture.ranges.listSnapshots("thread").map((row) => row.attempt_count)).toEqual([3, 3, 3]);
  });

  it("excludes an empty failed attempt and preserves the replacement's native evidence", async () => {
    await fixture.attempt({ id: "one", status: "Errored" });
    await fixture.attempt({ id: "two", attemptOf: "one", edits: { "c.ts": "c\n" } });
    fixture.native("two", PATCH);
    expect((await comparison("message-one")).turnDiff?.source).toBe("native");
    expect((await comparison("message-two")).files.map((file) => file.path)).toEqual(["c.ts"]);
    expect(fixture.ranges.listSnapshots("thread").map((row) => row.attempt_count)).toEqual([1]);
  });

  it.each(["expired", "never-written"])("does not shorten a turn whose first snapshot is %s", async (reason) => {
    await fixture.attempt({ id: "one", status: "Errored", ageDays: 31, missing: reason === "never-written", edits: { "a.ts": "a\n" } });
    const replacement = await fixture.attempt({ id: "two", attemptOf: "one", ageDays: 29, edits: { "b.ts": "b\n" } });
    const next = await fixture.attempt({ id: "next", edits: { "c.ts": "c\n" } });
    if (!replacement || !next) throw new Error("Fixture snapshot missing");
    await fixture.snapshots.deleteExpired(30);
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-two" }, fixture.deps)).toEqual({ status: "unavailable", reason: "snapshot-expired" });
    expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: "thread", comparisonId: `git:${replacement.id}`, filePath: "b.ts" }, fixture.deps)).toEqual({ status: "unavailable", reason: "snapshot-expired" });
    expect(await routeSnapshotRpc("snapshot.getDiffStats", { snapshotId: replacement.id }, fixture.deps)).toEqual({ status: "unavailable", reason: "snapshot-expired" });
    expect(fixture.ranges.listSnapshots("thread").map((row) => row.id)).toEqual([next.id]);
    expect(await routeTurnDiffRpc("turnDiff.listTurns", { threadId: "thread" }, fixture.deps)).toMatchObject([
      { messageId: "message-two", ordinal: 1, availability: "snapshot-expired" },
      { messageId: "message-next", ordinal: 2, availability: "available" },
    ]);
    const cumulative = ReviewComparisonResultSchema().parse(await routeSnapshotRpc("snapshot.getCumulativeDiffStats", { threadId: "thread" }, fixture.deps));
    expect(cumulative).toMatchObject({ status: "ready", comparison: { additions: 1, deletions: 0, files: [{ path: "c.ts" }] } });
  });

  it("takes whole turns across a span and skips incomplete turns inside it", async () => {
    await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "two", missing: true });
    await fixture.attempt({ id: "three", edits: { "b.ts": "b\n" }, status: "Errored" });
    await fixture.attempt({ id: "four", attemptOf: "three", edits: { "c.ts": "c\n" } });
    const range = fixture.ranges.turnSnapshotRange("thread", "message-three", "message-one");
    expect(range.status).toBe("ready");
    if (range.status !== "ready") throw new Error("Missing range");
    expect(range.rows.map((row) => row.message_id)).toEqual(["message-one", "message-three", "message-four"]);
    expect(range.paths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("does not require a snapshot from an attempt that has no assistant message", async () => {
    await fixture.attempt({ id: "one", noAssistant: true, status: "Errored" });
    await fixture.attempt({ id: "two", attemptOf: "one", edits: { "c.ts": "c\n" } });
    expect((await comparison("message-two")).files.map((file) => file.path)).toEqual(["c.ts"]);
  });

  it("preserves rename groups from different attempts without merging their shared path", async () => {
    await fixture.attempt({ id: "one", edits: { "b.ts": "b\n" } });
    await fixture.attempt({ id: "two", attemptOf: "one", edits: { "c.ts": "c\n" } });
    for (const [messageId, path, oldPath] of [["message-one", "b.ts", "a.ts"], ["message-two", "c.ts", "b.ts"]]) {
      fixture.db.prepare("UPDATE turn_snapshots SET file_effects = ? WHERE message_id = ?").run(JSON.stringify({
        revision: 1, fileCount: 1, additions: 0, deletions: 0,
        effects: [{ path, oldPath, scope: "workspace", kind: "renamed", additions: 0, deletions: 0, binary: false, toolCallIds: [] }],
      }), messageId);
    }
    const range = fixture.ranges.turnSnapshotRange("thread", "message-two");
    if (range.status !== "ready") throw new Error("Missing range");
    expect(range.pathGroups).toEqual([["b.ts", "a.ts"], ["c.ts", "b.ts"]]);
    expect(range.paths).toEqual(["b.ts", "a.ts", "c.ts"]);
  });

  it("uses only live replacement evidence until the replacement settles", async () => {
    await fixture.attempt({ id: "one", status: "Errored", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "two", attemptOf: "one", status: "Running", missing: true });
    const identity = { threadId: "thread", turnId: "two", turnExecutionId: "execution-two", deliveryAttempt: 1 };
    fixture.deps.turnDiffs.begin(identity);
    fixture.deps.turnDiffs.push({ ...identity, state: "snapshot", nativeFidelity: "agent", revision: 1, patch: PATCH });
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread" }, fixture.deps)).toMatchObject({
      status: "ready", comparison: { files: [{ path: "c.ts" }], turnDiff: { phase: "live", source: "native" } },
    });
    expect(await routeTurnDiffRpc("turnDiff.listTurns", { threadId: "thread" }, fixture.deps)).toMatchObject([
      { messageId: "message-two", ordinal: 1, phase: "live", fileCount: 1, availability: "available", evidence: "native" },
    ]);
  });
});
