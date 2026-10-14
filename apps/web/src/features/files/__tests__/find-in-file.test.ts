import { describe, expect, it } from "vitest";
import { DEFAULT_FIND_OPTIONS, MAX_FIND_MATCHES, findInLines, splitPieces, stepMatchIndex } from "../find-in-file";

const options = DEFAULT_FIND_OPTIONS;

function ranges(lines: string[], query: string, overrides: Partial<typeof options> = {}) {
  const result = findInLines(lines, query, { ...options, ...overrides });
  if (result.status !== "ready") throw new Error(`expected ready, got ${result.status}`);
  return result.matches.map((match) => [match.line, match.start, match.end]);
}

describe("findInLines", () => {
  it("is idle for an empty query and invalid for a pattern that does not compile", () => {
    expect(findInLines(["a"], "", options).status).toBe("idle");
    expect(findInLines(["a"], "(", { ...options, regex: true }).status).toBe("invalid");
  });

  it("treats regex metacharacters literally unless regex mode is on", () => {
    expect(ranges(["a.b axb"], "a.b")).toEqual([[0, 0, 3]]);
    expect(ranges(["a.b axb"], "a.b", { regex: true })).toEqual([[0, 0, 3], [0, 4, 7]]);
  });

  it("ignores case by default and honors it when asked", () => {
    expect(ranges(["Foo foo"], "foo")).toEqual([[0, 0, 3], [0, 4, 7]]);
    expect(ranges(["Foo foo"], "foo", { caseSensitive: true })).toEqual([[0, 4, 7]]);
  });

  it("matches whole words only", () => {
    expect(ranges(["cat concat cat."], "cat", { wholeWord: true })).toEqual([[0, 0, 3], [0, 11, 14]]);
  });

  it("skips empty matches so a pattern like a* terminates", () => {
    expect(ranges(["bbab"], "a*", { regex: true })).toEqual([[0, 2, 3]]);
  });

  it("reports matches line by line in document order", () => {
    expect(ranges(["x", "ax a", "a"], "a")).toEqual([[1, 0, 1], [1, 3, 4], [2, 0, 1]]);
  });

  it("stops at the cap and says so", () => {
    const result = findInLines(["a".repeat(MAX_FIND_MATCHES + 5)], "a", options);
    expect(result.status === "ready" && [result.matches.length, result.capped]).toEqual([MAX_FIND_MATCHES, true]);
  });
});

describe("stepMatchIndex", () => {
  it("wraps in both directions and survives zero matches", () => {
    expect(stepMatchIndex(2, 1, 3)).toBe(0);
    expect(stepMatchIndex(0, -1, 3)).toBe(2);
    expect(stepMatchIndex(0, 1, 0)).toBe(0);
  });
});

describe("splitPieces", () => {
  it("cuts a match that crosses tokens and keeps each token's color", () => {
    const pieces = [{ content: "const ", color: "red" }, { content: "value", color: "blue" }];
    expect(splitPieces(pieces, [{ start: 3, end: 8, current: true }])).toEqual([
      { content: "con", color: "red" },
      { content: "st ", color: "red", match: "current" },
      { content: "va", color: "blue", match: "current" },
      { content: "lue", color: "blue" },
    ]);
  });

  it("marks several matches inside one piece", () => {
    expect(
      splitPieces([{ content: "abab" }], [{ start: 0, end: 2, current: false }, { start: 2, end: 4, current: true }]),
    ).toEqual([{ content: "ab", match: "match" }, { content: "ab", match: "current" }]);
  });
});
