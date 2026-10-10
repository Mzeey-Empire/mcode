import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeTurnDiffRpc } from "../turn-diff-rpc.js";
import { createSnapshotRangeFixture } from "../../snapshots/__tests__/turn-snapshot-range-fixture.js";

describe("turn diff route outcomes", { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotRangeFixture>>;
  beforeEach(async () => { fixture = await createSnapshotRangeFixture(); });
  afterEach(async () => { await fixture.close(); });

  it("returns snapshot-expired for absent evidence", async () => {
    await fixture.attempt({ id: "one", missing: true });
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one" }, fixture.deps)).toEqual({ status: "unavailable", reason: "snapshot-expired" });
  });

  it("returns snapshot-pruned when Git evidence cannot be read", async () => {
    await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    fixture.db.prepare("UPDATE turn_snapshots SET ref_before = ?").run("0".repeat(40));
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one" }, fixture.deps)).toEqual({ status: "unavailable", reason: "snapshot-pruned" });
  });

  it("does not call absent Git refs pruned evidence", async () => {
    await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    fixture.db.prepare("UPDATE turn_snapshots SET ref_before = ''").run();
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one" }, fixture.deps))
      .toEqual({ status: "unavailable", reason: "snapshot-expired" });
  });

  it.each(["native", "tracked"] as const)("serves %s patches independently of empty or pruned refs", async (source) => {
    await fixture.attempt({ id: "one", edits: { "a.ts": "a\n" } });
    const patch = "diff --git a/a.ts b/a.ts\nnew file mode 100644\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+a\n";
    fixture.native("one", patch, source);
    for (const ref of ["", "0".repeat(40)]) {
      fixture.db.prepare("UPDATE turn_snapshots SET ref_before = ?, ref_after = ?").run(ref, ref);
      expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one" }, fixture.deps))
        .toMatchObject({ status: "ready", comparison: { files: [{ path: "a.ts", additions: 1 }], turnDiff: { source } } });
      expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: "thread", comparisonId: "native-one", filePath: "a.ts" }, fixture.deps)).toBe(patch);
    }
  });

  it("returns an empty ready comparison only when no turn was selected or recorded", async () => {
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread" }, fixture.deps))
      .toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "missing" }, fixture.deps))
      .toEqual({ status: "unavailable", reason: "snapshot-expired" });
    expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: "thread", comparisonId: "missing", filePath: "a.ts" }, fixture.deps))
      .toEqual({ status: "unavailable", reason: "snapshot-expired" });
    await fixture.attempt({ id: "one", missing: true });
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread" }, fixture.deps))
      .toEqual({ status: "unavailable", reason: "snapshot-expired" });
  });

  it("lists replacements once, includes unchanged turns, and keeps ordinals after expiry", async () => {
    await fixture.attempt({ id: "one", status: "Errored", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "retry", attemptOf: "one", edits: { "b.ts": "b\n" } });
    await fixture.attempt({ id: "next" });
    expect(await routeTurnDiffRpc("turnDiff.listTurns", { threadId: "thread" }, fixture.deps)).toMatchObject([
      { messageId: "message-retry", ordinal: 1, fileCount: 2, additions: null, deletions: null, evidence: "git", availability: "available" },
      { messageId: "message-next", ordinal: 2, fileCount: 0, availability: "available" },
    ]);
    fixture.db.prepare("DELETE FROM turn_snapshots WHERE message_id = ?").run("message-one");
    expect(await routeTurnDiffRpc("turnDiff.listTurns", { threadId: "thread" }, fixture.deps)).toMatchObject([
      { messageId: "message-retry", ordinal: 1, availability: "snapshot-expired" },
      { messageId: "message-next", ordinal: 2, availability: "available" },
    ]);
  });
});
