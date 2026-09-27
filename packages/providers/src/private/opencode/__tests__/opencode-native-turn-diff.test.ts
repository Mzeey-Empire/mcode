import { describe, expect, it } from "vitest";
import { OpenCodeNativeTurnDiff } from "../opencode-native-turn-diff.js";

/**
 * Build the exact patch shape upstream emits for one file: `Index:`/`====`
 * headers, then one full-context hunk covering both complete versions.
 * Only single-hunk, full-file replacements are needed for these tests.
 */
function upstreamPatch(file: string, before: string, after: string): string {
  const beforeLines = before.length === 0 ? [] : before.replace(/\n$/, "").split("\n");
  const afterLines = after.length === 0 ? [] : after.replace(/\n$/, "").split("\n");
  const body = [
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
  const beforeRange = beforeLines.length === 0 ? "0,0" : `1,${beforeLines.length}`;
  const afterRange = afterLines.length === 0 ? "0,0" : `1,${afterLines.length}`;
  return [
    `Index: ${file}`,
    "===================================================================",
    `--- ${file}`,
    `+++ ${file}`,
    `@@ -${beforeRange} +${afterRange} @@`,
    ...body,
    "",
  ].join("\n");
}

describe("OpenCodeNativeTurnDiff", () => {
  it("normalizes one upstream file patch into the canonical aggregate", () => {
    const before = "line one\nagent marker: old\nline three\n";
    const after = "line one\nagent marker: new\nline three\n";
    const diff = new OpenCodeNativeTurnDiff();
    const result = diff.observe([{ file: "notes.txt", patch: upstreamPatch("notes.txt", before, after), additions: 1, deletions: 1, status: "modified" }]);
    expect(result).toMatchObject({ state: "snapshot" });
    const patch = (result as { patch: string }).patch;
    expect(patch).toContain("diff --git a/notes.txt b/notes.txt");
    expect(patch).toContain("-agent marker: old");
    expect(patch).toContain("+agent marker: new");
    expect(patch).toContain(" line one");
    expect(patch).toContain(" line three");
  });

  it("keeps a same-file external edit out of the native aggregate", () => {
    // Upstream computes its diff between its own step snapshots, so a user
    // edit that landed between them never enters the evidence.
    const agentBefore = "user marker: untouched\nagent marker: old\n";
    const agentAfter = "user marker: untouched\nagent marker: new\n";
    const diff = new OpenCodeNativeTurnDiff();
    const result = diff.observe([{ file: "shared.txt", patch: upstreamPatch("shared.txt", agentBefore, agentAfter), additions: 1, deletions: 1, status: "modified" }]);
    const patch = (result as { patch: string }).patch;
    expect(patch).not.toContain("user marker: edited externally");
    expect(patch).toContain("-agent marker: old");
    expect(patch).toContain("+agent marker: new");
  });

  it("reports a reverted turn as indeterminate-empty, not a false empty patch", () => {
    const diff = new OpenCodeNativeTurnDiff();
    diff.observe([{ file: "a.txt", patch: upstreamPatch("a.txt", "x\n", "y\n"), additions: 1, deletions: 1, status: "modified" }]);
    // Upstream emits an empty diff list once the turn reverts to net-zero;
    // the service reconciles it against file effects instead of trusting it.
    expect(diff.observe([])).toEqual({ state: "indeterminate-empty" });
  });

  it("treats an empty first event as no information", () => {
    expect(new OpenCodeNativeTurnDiff().observe([])).toBeNull();
  });

  it("marks file creation and removal explicitly", () => {
    const diff = new OpenCodeNativeTurnDiff();
    const created = diff.observe([{ file: "new.txt", patch: upstreamPatch("new.txt", "", "fresh\n"), additions: 1, deletions: 0, status: "added" }]);
    expect((created as { patch: string }).patch).toContain("--- /dev/null");
    const removed = new OpenCodeNativeTurnDiff().observe([{ file: "old.txt", patch: upstreamPatch("old.txt", "stale\n", ""), additions: 0, deletions: 1, status: "deleted" }]);
    expect((removed as { patch: string }).patch).toContain("+++ /dev/null");
  });

  it.each([
    ["a missing patch (binary row)", [{ file: "blob.bin", additions: 0, deletions: 0 }]],
    ["a non-string patch", [{ file: "a.txt", patch: 42, additions: 1, deletions: 1 }]],
    ["an unsafe file name", [{ file: "../escape.txt", patch: upstreamPatch("x", "a\n", "b\n"), additions: 1, deletions: 1 }]],
    ["an oversized patch", [{ file: "big.txt", patch: upstreamPatch("big.txt", "x".repeat(2_097_153), "y\n"), additions: 1, deletions: 1 }]],
    ["a partial-context patch", [{ file: "a.txt", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n", additions: 1, deletions: 1 }]],
    // Upstream's full-context diff always emits one hunk; a second header
    // could pass the count check while fabricating duplicated lines.
    ["a multi-hunk patch", [{ file: "a.txt", patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-a\n+b\n", additions: 2, deletions: 2 }]],
  ])("rejects unusable evidence: %s", (_label, entries) => {
    expect(new OpenCodeNativeTurnDiff().observe(entries as unknown[])).toEqual({ state: "rejected" });
  });

  it("stays rejected after bad evidence instead of emitting a partial patch", () => {
    const diff = new OpenCodeNativeTurnDiff();
    diff.observe([{ file: "a.txt", patch: upstreamPatch("a.txt", "a\n", "b\n"), additions: 1, deletions: 1 }]);
    expect(diff.observe([{ file: "b.txt", additions: 0, deletions: 0 }])).toEqual({ state: "rejected" });
    expect(diff.observe([{ file: "c.txt", patch: upstreamPatch("c.txt", "c\n", "d\n"), additions: 1, deletions: 1 }])).toEqual({ state: "rejected" });
  });

  it("later events for the same file replace earlier evidence", () => {
    const diff = new OpenCodeNativeTurnDiff();
    diff.observe([{ file: "a.txt", patch: upstreamPatch("a.txt", "one\n", "two\n"), additions: 1, deletions: 1 }]);
    const result = diff.observe([{ file: "a.txt", patch: upstreamPatch("a.txt", "two\n", "three\n"), additions: 1, deletions: 1 }]);
    const patch = (result as { patch: string }).patch;
    expect(patch).toContain("+three");
    expect(patch).not.toContain("+two");
  });
});
