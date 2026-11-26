import {
  type FileDiffMetadata,
  hydratePartialDiff,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { splitColumnText, unifiedDiffText } from "../diff-text";

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`);

const OLD_FILE = `${numbered(1, 30).join("\n")}\n`;
const NEW_FILE = `${[
  ...numbered(1, 4),
  "line 5 changed",
  "line 5b added",
  ...numbered(6, 15),
  ...numbered(19, 30),
].join("\n")}\n`;

// No context lines: the second hunk has no new-file lines, so its header names the line before it.
const PATCH = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -5,1 +5,2 @@
-line 5
+line 5 changed
+line 5b added
@@ -16,3 +16,0 @@
-line 16
-line 17
-line 18
`;

const CHANGED_ROWS = [
  "line 5",
  "line 5 changed",
  "line 5b added",
];
const DELETED_ROWS = ["line 16", "line 17", "line 18"];

function parsePartial() {
  const file = parsePatchFiles(PATCH)[0]?.files[0];
  if (!file) throw new Error("the patch did not parse");
  return file;
}

describe("unifiedDiffText", () => {
  it("lists a patch-only diff's rows and leaves the collapsed rows before them empty", () => {
    const diff = parsePartial();

    const { text, unknown } = unifiedDiffText(diff);

    expect(diff.isPartial).toBe(true);
    expect(text.split("\n")).toEqual([
      ...Array<string>(4).fill(""),
      ...CHANGED_ROWS,
      ...Array<string>(10).fill(""),
      ...DELETED_ROWS,
    ]);
    expect([...unknown]).toEqual([0, 1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("fills collapsed rows with the new file's lines once the diff is hydrated", () => {
    const diff = hydratePartialDiff("clone", parsePartial(), {
      oldFile: { name: "a.txt", contents: OLD_FILE },
      newFile: { name: "a.txt", contents: NEW_FILE },
    });

    const { text, unknown } = unifiedDiffText(diff);

    expect(diff.isPartial).toBe(false);
    expect(unknown.size).toBe(0);
    expect(text.split("\n")).toEqual([
      ...numbered(1, 4),
      ...CHANGED_ROWS,
      ...numbered(6, 15),
      ...DELETED_ROWS,
      ...numbered(19, 30),
    ]);
  });

  it("matches a diff built from the two whole files", () => {
    const diff = parseDiffFromFile(
      { name: "a.txt", contents: OLD_FILE },
      { name: "a.txt", contents: NEW_FILE },
    );

    const rows = unifiedDiffText(diff).text.split("\n");

    expect(rows).toHaveLength(diff.unifiedLineCount);
    expect(rows.slice(0, 4)).toEqual(numbered(1, 4));
    expect(rows.at(-1)).toBe("line 30");
    expect(rows).toContain("line 5b added");
    expect(rows).toContain("line 17");
  });

  it("drops carriage returns, which a row's text does not hold", () => {
    const diff = parseDiffFromFile(
      { name: "crlf.txt", contents: "one\r\ntwo\r\nthree" },
      { name: "crlf.txt", contents: "one\r\n2\r\nthree" },
    );

    expect(unifiedDiffText(diff).text).toBe("one\ntwo\n2\nthree");
  });
});

// A 1-to-2 change, a pure deletion, a pure addition, and a collapsed gap before each hunk.
const SPLIT_PATCH = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -5,1 +5,2 @@
-line 5
+line 5 changed
+line 5b added
@@ -16,3 +16,0 @@
-line 16
-line 17
-line 18
@@ -24,0 +23,2 @@
+added a
+added b
`;

const SPLIT_NEW_FILE = `${[
  ...numbered(1, 4),
  "line 5 changed",
  "line 5b added",
  ...numbered(6, 15),
  ...numbered(19, 24),
  "added a",
  "added b",
  ...numbered(25, 30),
].join("\n")}\n`;

/** One entry per split row: its text, or `undefined` for a row whose text is unknown. */
function splitLines(diff: FileDiffMetadata, side: "deletions" | "additions") {
  const { text, unknown } = splitColumnText(diff, side);
  return text.split("\n").map((line, index) => (unknown.has(index) ? undefined : line));
}

const gap = (count: number) => Array<undefined>(count).fill(undefined);

describe("splitColumnText", () => {
  it("places each side's lines at the shared split rows of a patch-only diff", () => {
    const diff = parsePatchFiles(SPLIT_PATCH)[0]!.files[0]!;

    expect(splitLines(diff, "deletions")).toEqual([
      ...gap(4),
      "line 5",
      undefined, // buffer: the new side has a second line here
      ...gap(10),
      "line 16",
      "line 17",
      "line 18",
      ...gap(6),
      undefined, // buffers: the old side has nothing for the added lines
      undefined,
    ]);
    expect(splitLines(diff, "additions")).toEqual([
      ...gap(4),
      "line 5 changed",
      "line 5b added",
      ...gap(10),
      undefined, // buffers: the new side has nothing for the deleted lines
      undefined,
      undefined,
      ...gap(6),
      "added a",
      "added b",
    ]);
  });

  it("fills the collapsed rows of a hydrated diff and leaves only the buffers unknown", () => {
    const diff = hydratePartialDiff("clone", parsePatchFiles(SPLIT_PATCH)[0]!.files[0]!, {
      oldFile: { name: "a.txt", contents: OLD_FILE },
      newFile: { name: "a.txt", contents: SPLIT_NEW_FILE },
    });

    expect(splitLines(diff, "deletions")).toEqual([
      ...numbered(1, 4),
      "line 5",
      undefined,
      ...numbered(6, 15),
      "line 16",
      "line 17",
      "line 18",
      ...numbered(19, 24),
      undefined,
      undefined,
      ...numbered(25, 30),
    ]);
    expect(splitLines(diff, "additions")).toEqual([
      ...numbered(1, 4),
      "line 5 changed",
      "line 5b added",
      ...numbered(6, 15),
      undefined,
      undefined,
      undefined,
      ...numbered(19, 24),
      "added a",
      "added b",
      ...numbered(25, 30),
    ]);
  });
});
