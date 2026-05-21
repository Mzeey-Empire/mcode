import { describe, it, expect } from "vitest";
import { parseFirstHunkLine } from "../parse-first-hunk-line";

describe("parseFirstHunkLine", () => {
  it("returns the new-start line from the first hunk", () => {
    const diff = `@@ -42,3 +44,18 @@ ## Installation
 context
-old
+new`;
    expect(parseFirstHunkLine(diff)).toBe(44);
  });

  it("handles hunks without explicit length (single-line)", () => {
    const diff = `@@ -14 +14 @@
-old
+new`;
    expect(parseFirstHunkLine(diff)).toBe(14);
  });

  it("ignores any hunks after the first", () => {
    const diff = `@@ -10,3 +12,5 @@
+a
@@ -50,1 +60,1 @@
+b`;
    expect(parseFirstHunkLine(diff)).toBe(12);
  });

  it("skips file headers and returns the first hunk line", () => {
    const diff = `diff --git a/x b/x
index abc..def 100644
--- a/x
+++ b/x
@@ -1,2 +3,4 @@
 context
+added`;
    expect(parseFirstHunkLine(diff)).toBe(3);
  });

  it("returns undefined for diffs without hunks", () => {
    expect(parseFirstHunkLine("")).toBeUndefined();
    expect(parseFirstHunkLine("diff --git a/x b/x\n")).toBeUndefined();
  });

  it("returns undefined for malformed hunk headers", () => {
    expect(parseFirstHunkLine("@@ malformed @@")).toBeUndefined();
  });
});
