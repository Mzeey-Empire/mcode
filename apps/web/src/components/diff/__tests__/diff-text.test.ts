import { hydratePartialDiff, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { unifiedDiffText } from "../diff-text";

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `line ${from + index}`);

const OLD_FILE = `${numbered(1, 30).join("\n")}\n`;
// Line 5 becomes two lines, and lines 16 to 18 go.
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

    const rows = unifiedDiffText(diff).split("\n");

    expect(diff.isPartial).toBe(true);
    expect(rows).toEqual([
      ...Array<string>(4).fill(""),
      ...CHANGED_ROWS,
      ...Array<string>(10).fill(""),
      ...DELETED_ROWS,
    ]);
  });

  it("fills collapsed rows with the new file's lines once the diff is hydrated", () => {
    const diff = hydratePartialDiff("clone", parsePartial(), {
      oldFile: { name: "a.txt", contents: OLD_FILE },
      newFile: { name: "a.txt", contents: NEW_FILE },
    });

    const rows = unifiedDiffText(diff).split("\n");

    expect(diff.isPartial).toBe(false);
    expect(rows).toEqual([
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

    const rows = unifiedDiffText(diff).split("\n");

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

    expect(unifiedDiffText(diff)).toBe("one\ntwo\n2\nthree");
  });
});
