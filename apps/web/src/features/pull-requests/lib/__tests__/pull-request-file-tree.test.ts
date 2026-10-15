import { describe, expect, it } from "vitest";
import { orderCommitFiles } from "@/lib/commit-selection";
import { orderReviewFiles } from "@/lib/review-file-order";
import {
  buildPullRequestFileTree,
  collectPullRequestDirectoryIds,
  flattenPullRequestFileTree,
} from "../pull-request-file-tree";

describe("pull request file tree", () => {
  it("builds stable directory-first rows and ignores duplicate paths", () => {
    const tree = buildPullRequestFileTree([
      "README.md",
      "apps/web/src/zeta.ts",
      "apps/web/src/alpha.ts",
      "apps/web/src/alpha.ts",
      "apps/server/index.ts",
    ]);
    const rows = flattenPullRequestFileTree(
      tree,
      new Set(collectPullRequestDirectoryIds(tree)),
    );

    expect(rows.map((row) => `${row.node.kind}:${row.node.path}`)).toEqual([
      "directory:apps",
      "directory:apps/server",
      "file:apps/server/index.ts",
      "directory:apps/web/src",
      "file:apps/web/src/alpha.ts",
      "file:apps/web/src/zeta.ts",
      "file:README.md",
    ]);
  });

  it("only exposes children of expanded directories", () => {
    const tree = buildPullRequestFileTree([
      "apps/web/src/App.tsx",
      "packages/contracts/src/index.ts",
    ]);
    const collapsed = flattenPullRequestFileTree(tree, new Set());
    expect(collapsed.map((row) => row.node.path)).toEqual([
      "apps/web/src",
      "packages/contracts/src",
    ]);

    const appsOpen = flattenPullRequestFileTree(
      tree,
      new Set(["directory:apps/web/src"]),
    );
    expect(appsOpen.map((row) => row.node.path)).toEqual([
      "apps/web/src",
      "apps/web/src/App.tsx",
      "packages/contracts/src",
    ]);
  });

  it("compacts a directory chain that contains no sibling files", () => {
    const tree = buildPullRequestFileTree([
      ".octopus/qualtex-launchpad/deployment_process.ocl",
      ".octopus/qualtex-launchpad/variables.ocl",
    ]);

    expect(tree).toMatchObject([
      {
        kind: "directory",
        id: "directory:.octopus/qualtex-launchpad",
        name: ".octopus/qualtex-launchpad",
        path: ".octopus/qualtex-launchpad",
      },
    ]);
  });

  it("provides one-based hierarchy metadata for a roving tree", () => {
    const tree = buildPullRequestFileTree(["a.ts", "b.ts"]);
    const rows = flattenPullRequestFileTree(tree, new Set());

    expect(rows).toMatchObject([
      { depth: 1, positionInSet: 1, setSize: 2 },
      { depth: 1, positionInSet: 2, setSize: 2 },
    ]);
  });
});

describe("review file order", () => {
  const paths = (ordered: readonly { path: string }[]) => ordered.map((file) => file.path);

  it("matches the tree's depth-first order, folders first and numbers by value", () => {
    const ordered = orderReviewFiles(
      ["b.ts", "a/z.ts", "a/b/10.ts", "a/b/9.ts"].map((path) => ({ path })),
    );

    expect(paths(ordered)).toEqual(["a/b/9.ts", "a/b/10.ts", "a/z.ts", "b.ts"]);
  });

  it("orders a backslash path by its folders without changing the path it returns", () => {
    const windowsPath = ["src", "a.ts"].join(String.fromCharCode(92));

    const ordered = orderReviewFiles([{ path: "z.ts" }, { path: windowsPath }]);

    expect(paths(ordered)).toEqual([windowsPath, "z.ts"]);
  });

  it("gives the Commit sheet the same order within tracked and untracked files", () => {
    const file = (path: string, untracked: boolean) => ({
      path, previousPath: null, changeType: "modified" as const, binary: false, additions: null, deletions: null, untracked,
    });

    const ordered = orderCommitFiles([
      file("new.ts", true), file("b.ts", false), file("a/z.ts", false), file("a/b/10.ts", false), file("a/b/9.ts", false),
    ]);

    expect(paths(ordered)).toEqual(["a/b/9.ts", "a/b/10.ts", "a/z.ts", "b.ts", "new.ts"]);
  });
});
