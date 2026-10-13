import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeTurnDiffRpc } from "../turn-diff-rpc.js";
import { deriveTurnAssistantMessageId } from "../../../../agents/turns/turn-assistant-message-id.js";
import { createSnapshotRangeFixture } from "../../snapshots/__tests__/turn-snapshot-range-fixture.js";
import { SnapshotService } from "../../snapshots/snapshot-service.js";
import { FakeGitExecutor } from "../../../git/execution/fake-git-executor.js";

describe("turn diff route outcomes", { timeout: 30_000 }, () => {
  let fixture: Awaited<ReturnType<typeof createSnapshotRangeFixture>>;
  beforeEach(async () => { fixture = await createSnapshotRangeFixture(); });
  afterEach(async () => { await fixture.close(); });

  it("passes -w to Git fallback reads and excludes whitespace-only recorded files", async () => {
    const row = await fixture.attempt({ id: "one", edits: { "space.ts": "a b\n", "code.ts": "code\n" } });
    if (!row) throw new Error("Fixture snapshot missing");
    const fake = new FakeGitExecutor();
    fake.setResponse(["cat-file", "-t", row.ref_before], { stdout: "tree\n", stderr: "" });
    fake.setResponse(["cat-file", "-t", row.ref_after], { stdout: "tree\n", stderr: "" });
    fixture.deps.snapshotService = new SnapshotService(fake);
    const patch = "diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-before\n+after\n";
    for (const ignoreWhitespace of [false, true]) {
      const flags = ignoreWhitespace ? ["-w"] : [];
      const range = ["--find-renames", row.ref_before, row.ref_after, ...flags];
      const paths = ["--", ":(literal)space.ts", ":(literal)code.ts"];
      fake.setResponse(["diff", "--name-status", ...range, ...paths], { stdout: "M\tspace.ts\nM\tcode.ts\n", stderr: "" });
      fake.setResponse(["diff", "--numstat", ...range, ...paths], { stdout: "1\t1\tcode.ts\n" + (ignoreWhitespace ? "" : "2\t2\tspace.ts\n"), stderr: "" });
      fake.setResponse(["diff", ...range, "--", ":(literal)code.ts"], { stdout: patch, stderr: "" });
      const comparison = await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one", ignoreWhitespace }, fixture.deps);
      expect(comparison).toMatchObject({ status: "ready", comparison: {
        files: ignoreWhitespace ? [{ path: "code.ts", additions: 1, deletions: 1 }] : [
          { path: "space.ts", additions: 2, deletions: 2 }, { path: "code.ts", additions: 1, deletions: 1 },
        ], additions: ignoreWhitespace ? 1 : 3, deletions: ignoreWhitespace ? 1 : 3,
      } });
      expect(await routeTurnDiffRpc("turnDiff.getFileDiff", {
        threadId: "thread", comparisonId: `git:${row.id}`, filePath: "code.ts", ignoreWhitespace,
      }, fixture.deps)).toBe(patch);
      expect(fake.calls.filter((call) => call.args.includes("diff")).slice(-3).map((call) => call.args.includes("-w")))
        .toEqual([ignoreWhitespace, ignoreWhitespace, ignoreWhitespace]);
    }
  });

  it("hides whitespace-only Git fallback files and patches with real Git", async () => {
    await fixture.attempt({ id: "base", edits: { "space.ts": "a b\n" } });
    const row = await fixture.attempt({ id: "one", edits: { "space.ts": "a  b\n" } });
    if (!row) throw new Error("Fixture snapshot missing");
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one", ignoreWhitespace: true }, fixture.deps))
      .toMatchObject({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
    expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: "thread", comparisonId: `git:${row.id}`, filePath: "space.ts", ignoreWhitespace: true }, fixture.deps)).toBe("");
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", messageId: "message-one" }, fixture.deps))
      .toMatchObject({ status: "ready", comparison: { files: [{ path: "space.ts", additions: 1, deletions: 1 }], additions: 1, deletions: 1 } });
  });

  it.each(["native", "tracked", "live"] as const)("leaves %s whitespace patches and comparisons unchanged", async (source) => {
    const patch = "diff --git a/space.ts b/space.ts\n--- a/space.ts\n+++ b/space.ts\n@@ -1 +1 @@\n-a b\n+a  b\n";
    let comparisonId = "native-one";
    if (source === "live") {
      const identity = { threadId: "thread", turnId: "one", turnExecutionId: "execution-one", deliveryAttempt: 1 };
      fixture.deps.turnDiffs.begin(identity);
      fixture.deps.turnDiffs.push({ ...identity, revision: 1, state: "snapshot", patch });
      comparisonId = "live:one:execution-one:1:1";
    } else {
      await fixture.attempt({ id: "one", edits: { "space.ts": "a  b\n" } });
      fixture.native("one", patch, source);
    }
    const original = await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread" }, fixture.deps);
    expect(original).toMatchObject({ status: "ready", comparison: {
      files: [{ path: "space.ts", changeType: "modified", additions: 1, deletions: 1 }], additions: 1, deletions: 1,
    } });
    expect(await routeTurnDiffRpc("turnDiff.getComparison", { threadId: "thread", ignoreWhitespace: true }, fixture.deps)).toEqual(original);
    for (const ignoreWhitespace of [undefined, true]) {
      expect(await routeTurnDiffRpc("turnDiff.getFileDiff", { threadId: "thread", comparisonId, filePath: "space.ts", ignoreWhitespace }, fixture.deps)).toBe(patch);
    }
  });

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

  it("answers a picked running turn with its live evidence, never an earlier attempt", async () => {
    await fixture.attempt({ id: "one", status: "Errored", edits: { "a.ts": "a\n" } });
    await fixture.attempt({ id: "retry", attemptOf: "one", status: "Running", missing: true });
    const liveMessageId = deriveTurnAssistantMessageId("thread", "user-retry");
    const request = { threadId: "thread", messageId: liveMessageId };

    expect(await routeTurnDiffRpc("turnDiff.getComparison", request, fixture.deps))
      .toEqual({ status: "ready", comparison: { files: [], additions: 0, deletions: 0 } });
    expect(await routeTurnDiffRpc("turnDiff.listTurns", { threadId: "thread" }, fixture.deps))
      .toMatchObject([{ messageId: liveMessageId, phase: "live", fileCount: 0, availability: "available" }]);

    const live = { files: [{ path: "b.ts", previousPath: null, changeType: "added" as const, binary: false, additions: 1, deletions: 0, untracked: false }],
      additions: 1, deletions: 0, turnDiff: { id: "live-1", phase: "live" as const, source: "native" as const, fidelity: "agent" as const, revision: 1 } };
    vi.spyOn(fixture.deps.turnDiffs, "liveComparison").mockReturnValue(live);
    expect(await routeTurnDiffRpc("turnDiff.getComparison", request, fixture.deps)).toEqual({ status: "ready", comparison: live });
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
