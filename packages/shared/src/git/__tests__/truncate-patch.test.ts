import { describe, expect, it } from "vitest";
import { truncateUnifiedDiff } from "../truncate-patch.js";

/** Assert every hunk header's declared counts match the body lines present. */
function expectCompleteHunks(patch: string): void {
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (!match) continue;
    let old = Number(match[2] ?? 1);
    let next = Number(match[4] ?? 1);
    let j = i + 1;
    while (old + next > 0) {
      const prefix = lines[j]?.[0];
      expect(prefix, `hunk at line ${i} ends early`).toMatch(/^[-+ ]$/);
      if (prefix === " ") {
        old--;
        next--;
      } else if (prefix === "-") old--;
      else next--;
      j++;
      if (lines[j] === "\\ No newline at end of file") j++;
    }
  }
}

const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+2",
  "+2b",
  " three",
  "@@ -10,3 +11,4 @@",
  " ten",
  "-eleven",
  "+11",
  "+11b",
  " twelve",
  "diff --git a/b.txt b/b.txt",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -1,3 +1,4 @@",
  " a",
  "-b",
  "+c",
  "+d",
  " e",
  "diff --git a/c.txt b/c.txt",
  "--- a/c.txt",
  "+++ b/c.txt",
  "@@ -1,3 +1,4 @@",
  " x",
  "-y",
  "+z",
  "+w",
  " tail",
].join("\n") + "\n";

describe("truncateUnifiedDiff", () => {
  it("returns the input when maxLines is undefined or exceeds the length", () => {
    expect(truncateUnifiedDiff(PATCH, undefined)).toBe(PATCH);
    expect(truncateUnifiedDiff(PATCH, 0)).toBe(PATCH);
    expect(truncateUnifiedDiff(PATCH, 10_000)).toBe(PATCH);
  });

  it("drops a hunk cut mid-body and keeps earlier complete hunks", () => {
    // Cutting inside b.txt's only hunk drops its headers too.
    const lines = PATCH.split("\n");
    const hunkB = lines.indexOf("+++ b/b.txt") + 1;
    const truncated = truncateUnifiedDiff(PATCH, hunkB + 3);
    expect(truncated).not.toContain("b.txt");
    expect(truncated).toContain("a/a.txt");
    expectCompleteHunks(truncated);
    expect(truncated.split("\n").length).toBeLessThanOrEqual(hunkB + 3);
  });

  it("keeps every line budget allows when cuts land on hunk boundaries", () => {
    for (let maxLines = 1; maxLines < PATCH.split("\n").length; maxLines++) {
      const truncated = truncateUnifiedDiff(PATCH, maxLines);
      expect(truncated.split("\n").length).toBeLessThanOrEqual(maxLines);
      expectCompleteHunks(truncated);
    }
  });

  it("keeps the \\ No newline marker with its hunk", () => {
    const noEof = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+c",
      "\\ No newline at end of file",
      "diff --git a/d.txt b/d.txt",
      "--- a/d.txt",
      "+++ b/d.txt",
      "@@ -1,1 +1,1 @@",
      "-q",
      "+r",
    ].join("\n") + "\n";
    // The marker is line index 7; cutting after it keeps a complete hunk.
    const truncated = truncateUnifiedDiff(noEof, 9);
    expect(truncated).toContain("\\ No newline at end of file");
    expectCompleteHunks(truncated);
    // Cutting before the marker drops the whole hunk and the trailing file.
    const tighter = truncateUnifiedDiff(noEof, 7);
    expect(tighter).not.toContain("a.txt");
    expect(tighter).not.toContain("d.txt");
  });

  it("handles headers without counts and zero counts", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "@@ -5,0 +5 @@",
      "+appended",
    ].join("\n") + "\n";
    const truncated = truncateUnifiedDiff(patch, 7);
    expect(truncated).toContain("@@ -1 +1 @@");
    expect(truncated).not.toContain("@@ -5,0 +5 @@");
    expectCompleteHunks(truncated);
  });

  it("counts bare empty lines as context (diff.suppressBlankEmpty)", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "",
      " three",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
    ].join("\n") + "\n";
    const truncated = truncateUnifiedDiff(patch, 8);
    expect(truncated).toContain("a/a.txt");
    expect(truncated).not.toContain("b.txt");
  });
});
