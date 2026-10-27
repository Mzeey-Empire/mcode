import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { WorkspaceFileChanges } from "@mcode/contracts/models/workspace-file";
import { FileTree } from "../FileTree";
import { buildFilesTree, flattenFileTree, indexFileChanges } from "../file-tree-model";

// jsdom has no layout, so render every virtual row.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * estimateSize(), size: estimateSize() })),
    scrollToIndex: vi.fn(),
    measureElement: vi.fn(),
  }),
}));

const PATHS = ["apps/web/src/main.ts", "apps/web/src/new.ts", "docs/guide.md", "README.md"];
const CHANGES: WorkspaceFileChanges = {
  git: true,
  truncated: false,
  entries: [
    { path: "apps/web/src/main.ts", mark: "M" },
    { path: "apps/web/src/new.ts", mark: "A" },
  ],
};

function renderTree(expanded: readonly string[]) {
  const rows = flattenFileTree(buildFilesTree(PATHS), new Set(expanded), indexFileChanges(CHANGES));
  render(
    <FileTree
      rows={rows}
      activePath={null}
      truncated={false}
      revealPath={null}
      onRevealed={() => {}}
      onToggleFolder={() => {}}
      onOpenFile={() => {}}
    />,
  );
}

function row(path: string): HTMLElement {
  const match = screen.getAllByRole("treeitem").find((item) => item.getAttribute("data-path") === path);
  if (!match) throw new Error(`no row for ${path}`);
  return match;
}

describe("FileTree", () => {
  it("compacts single-child folder chains into one row", () => {
    renderTree([]);
    const paths = screen.getAllByRole("treeitem").map((item) => item.getAttribute("data-path"));
    expect(paths).toContain("apps/web/src");
    expect(paths).not.toContain("apps");
    expect(row("apps/web/src").textContent).toContain("apps/web/src");
  });

  it("marks modified and added files", () => {
    renderTree(["apps/web/src"]);
    expect(within(row("apps/web/src/main.ts")).getByLabelText("Modified")).toBeTruthy();
    expect(within(row("apps/web/src/new.ts")).getByLabelText("Added")).toBeTruthy();
    expect(within(row("README.md")).queryByLabelText("Modified")).toBeNull();
  });

  it("dots folders that contain changes, even collapsed", () => {
    renderTree([]);
    expect(within(row("apps/web/src")).getByLabelText("Contains changes")).toBeTruthy();
    expect(within(row("docs")).queryByLabelText("Contains changes")).toBeNull();
  });
});
