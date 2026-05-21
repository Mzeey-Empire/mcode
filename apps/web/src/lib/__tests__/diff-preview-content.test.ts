import { describe, it, expect } from "vitest";
import { parseDiffLines } from "../diff-parser";
import { reconstructWithChangeMap } from "../diff-preview-content";

describe("reconstructWithChangeMap", () => {
  it("returns empty content and empty added set for no lines", () => {
    const { content, addedLines } = reconstructWithChangeMap([]);
    expect(content).toBe("");
    expect(addedLines.size).toBe(0);
  });

  it("emits context lines and tracks no additions", () => {
    const diff = `@@ -1,3 +1,3 @@
 a
 b
 c`;
    const { content, addedLines } = reconstructWithChangeMap(parseDiffLines(diff));
    expect(content).toBe("a\nb\nc");
    expect(addedLines.size).toBe(0);
  });

  it("records 1-based line numbers in the output for added lines", () => {
    const diff = `@@ -1,2 +1,4 @@
 a
+b
+c
 d`;
    const { content, addedLines } = reconstructWithChangeMap(parseDiffLines(diff));
    expect(content).toBe("a\nb\nc\nd");
    // Lines 2 and 3 of the reconstructed output are the added ones.
    expect(addedLines.has(2)).toBe(true);
    expect(addedLines.has(3)).toBe(true);
    expect(addedLines.has(1)).toBe(false);
    expect(addedLines.has(4)).toBe(false);
  });

  it("omits removed lines from the reconstructed content", () => {
    const diff = `@@ -1,3 +1,2 @@
 a
-b
 c`;
    const { content, addedLines } = reconstructWithChangeMap(parseDiffLines(diff));
    expect(content).toBe("a\nc");
    expect(addedLines.size).toBe(0);
  });

  it("ignores the \\ No newline at end of file marker", () => {
    const diff = `@@ -1,1 +1,2 @@
 a
+b
\\ No newline at end of file`;
    const { content, addedLines } = reconstructWithChangeMap(parseDiffLines(diff));
    expect(content).toBe("a\nb");
    expect(addedLines.has(2)).toBe(true);
  });

  it("handles a mix of added and removed lines across hunks", () => {
    const diff = `@@ -1,2 +1,3 @@
 a
+b
 c
@@ -10,2 +11,2 @@
 d
-e
+f`;
    const { content, addedLines } = reconstructWithChangeMap(parseDiffLines(diff));
    expect(content).toBe("a\nb\nc\nd\nf");
    expect(addedLines.has(2)).toBe(true); // b
    expect(addedLines.has(5)).toBe(true); // f
    expect(addedLines.size).toBe(2);
  });
});
