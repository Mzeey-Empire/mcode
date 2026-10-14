import { describe, expect, it } from "vitest";
import { rankFilePaths } from "../rank-file-path";

const PATHS = [
  "apps/web/src/features/thread/threadAttention.ts",
  "apps/web/src/components/thread/ThreadActivityList.tsx",
  "apps/web/src/components/thread/ThreadActionsMenu.tsx",
  "apps/web/src/thread/react/actions.ts",
  "docs/thread-actions.md",
  "apps/web/src/components/chat/Composer.tsx",
];

describe("rankFilePaths", () => {
  it("ranks ThreadActionsMenu.tsx first for 'thread act'", () => {
    const [first] = rankFilePaths(PATHS, "thread act");
    expect(first.path).toBe("apps/web/src/components/thread/ThreadActionsMenu.tsx");
  });

  it("returns path indices of the matched letters in order", () => {
    const [first] = rankFilePaths(["src/Composer.tsx"], "comp");
    const letters = first.matches.map((index) => first.path[index]).join("").toLowerCase();
    expect(letters).toBe("comp");
    expect(first.matches[0]).toBe("src/".length);
  });

  it("drops paths the query is not a subsequence of", () => {
    expect(rankFilePaths(PATHS, "zzq")).toEqual([]);
  });

  it("prefers the shorter path when scores tie", () => {
    const ranked = rankFilePaths(["a/long/folder/index.ts", "b/index.ts"], "index");
    expect(ranked.map((result) => result.path)).toEqual(["b/index.ts", "a/long/folder/index.ts"]);
  });

  it("prefers a basename match over letters spread through folders", () => {
    const ranked = rankFilePaths(["menu/u/x.ts", "src/menu.ts"], "menu");
    expect(ranked[0].path).toBe("src/menu.ts");
  });

  it("caps results at the limit", () => {
    expect(rankFilePaths(PATHS, "t", 2)).toHaveLength(2);
  });
});
