import { describe, expect, it } from "vitest";
import type { TurnSnapshot } from "@mcode/contracts";
import {
  buildChangesTree,
  initialCollapse,
  pathsEditedLater,
  visibleRows,
  type ChangedFile,
  type ChangesRow,
} from "../changes-tree";

function file(path: string, additions = 1, deletions = 0): ChangedFile {
  return { path, kind: "modified", counts: { kind: "lines", additions, deletions }, editedLater: false };
}

function describeRow(row: ChangesRow): string {
  const indent = "  ".repeat(row.depth);
  return row.kind === "file"
    ? `${indent}${row.file.path}`
    : `${indent}[${row.folder.label}]${row.collapsed ? " (collapsed)" : ""}`;
}

function rowsOf(files: ChangedFile[], collapsed: ReadonlySet<string> = new Set()): string[] {
  return visibleRows(buildChangesTree(files), collapsed).map(describeRow);
}

function snapshot(overrides: Partial<TurnSnapshot>): TurnSnapshot {
  return {
    id: "snap",
    message_id: "msg",
    thread_id: "thread-1",
    ref_before: "a",
    ref_after: "b",
    files_changed: [],
    worktree_path: null,
    created_at: "2026-10-01T10:00:00.000Z",
    attempt_count: 1,
    ...overrides,
  };
}

describe("buildChangesTree", () => {
  it("strips the directory prefix every file shares", () => {
    expect(rowsOf([file("apps/web/src/a.ts"), file("apps/web/src/lib/b.ts")])).toEqual([
      "apps/web/src/a.ts",
      "[lib]",
      "  apps/web/src/lib/b.ts",
    ]);
  });

  it("shows files in one shared directory as root files", () => {
    expect(rowsOf([file("src/z.ts"), file("src/a.ts")])).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("compresses a chain of single-child folders into one label", () => {
    expect(rowsOf([file("README.md"), file("web/components/chat/Bar.tsx"), file("web/components/chat/Row.tsx")])).toEqual([
      "README.md",
      "[web/components/chat]",
      "  web/components/chat/Bar.tsx",
      "  web/components/chat/Row.tsx",
    ]);
  });

  it("lists files A-Z before subfolders A-Z at every level", () => {
    expect(
      rowsOf([
        file("pkg/zeta/x.ts"),
        file("pkg/b.ts"),
        file("pkg/alpha/y.ts"),
        file("pkg/a.ts"),
        file("root.ts"),
        file("pkg/alpha/inner/z.ts"),
      ]),
    ).toEqual([
      "root.ts",
      "[pkg]",
      "  pkg/a.ts",
      "  pkg/b.ts",
      "  [alpha]",
      "    pkg/alpha/y.ts",
      "    [inner]",
      "      pkg/alpha/inner/z.ts",
      "  [zeta]",
      "    pkg/zeta/x.ts",
    ]);
  });

  it("gives each folder its recursive file count and summed line counts", () => {
    const tree = buildChangesTree([
      file("top.ts", 100, 100),
      file("server/a.ts", 10, 2),
      file("server/deep/b.ts", 5, 3),
      { path: "server/deep/logo.png", kind: "added", counts: { kind: "binary" }, editedLater: false },
      { path: "server/c.ts", kind: "modified", counts: { kind: "uncounted" }, editedLater: false },
    ]);
    const [server] = tree.folders;
    expect(server).toMatchObject({ label: "server", fileCount: 4, additions: 15, deletions: 5 });
    expect(server?.folders[0]).toMatchObject({ id: "server/deep", label: "deep", fileCount: 2, additions: 5, deletions: 3 });
  });

  it("collapses only the folder whose id is listed", () => {
    expect(rowsOf([file("a/x.ts"), file("b/y.ts")], new Set(["a"]))).toEqual([
      "[a] (collapsed)",
      "[b]",
      "  b/y.ts",
    ]);
  });
});

describe("initialCollapse", () => {
  it("leaves a list of 12 rows fully open", () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`src/f${String(i).padStart(2, "0")}.ts`));
    expect(initialCollapse(buildChangesTree(files))).toEqual({ collapsedFolders: new Set(), rowLimit: null, footer: null });
  });

  it("collapses every top-level folder when more than 12 rows would show", () => {
    const files = [
      ...Array.from({ length: 5 }, (_, i) => file(`server/agents/a${i}.ts`)),
      ...Array.from({ length: 5 }, (_, i) => file(`web/chat/c${i}.ts`)),
      ...Array.from({ length: 3 }, (_, i) => file(`web/projects/p${i}.ts`)),
    ];
    const tree = buildChangesTree(files);
    const start = initialCollapse(tree);
    expect(start).toEqual({
      collapsedFolders: new Set(["server/agents", "web"]),
      rowLimit: null,
      footer: { kind: "folders", count: 2 },
    });
    expect(visibleRows(tree, start.collapsedFolders).map(describeRow)).toEqual([
      "[server/agents] (collapsed)",
      "[web] (collapsed)",
    ]);
  });

  it("caps a root-only list at 12 rows and counts the rest", () => {
    const files = Array.from({ length: 15 }, (_, i) => file(`src/f${String(i).padStart(2, "0")}.ts`));
    expect(initialCollapse(buildChangesTree(files))).toEqual({
      collapsedFolders: new Set(),
      rowLimit: 12,
      footer: { kind: "files", count: 3 },
    });
  });
});

describe("pathsEditedLater", () => {
  it("collects paths that later snapshots in the same thread attribute", () => {
    const current = snapshot({ id: "s1", created_at: "2026-10-01T10:00:00.000Z" });
    const earlier = snapshot({ id: "s0", created_at: "2026-10-01T09:00:00.000Z", files_changed: ["early.ts"] });
    const laterLegacy = snapshot({ id: "s2", created_at: "2026-10-01T11:00:00.000Z", files_changed: ["src\\legacy.ts"] });
    const laterWithEffects = snapshot({
      id: "s3",
      created_at: "2026-10-01T12:00:00.000Z",
      files_changed: ["ignored-by-effects.ts"],
      file_effects: {
        revision: 1,
        fileCount: 1,
        additions: 1,
        deletions: 0,
        effects: [
          { path: "src/effect.ts", kind: "edited", scope: "workspace", additions: 1, deletions: 0, binary: false, toolCallIds: [] },
        ],
      },
    });
    const otherThread = snapshot({ id: "s4", thread_id: "thread-2", created_at: "2026-10-02T00:00:00.000Z", files_changed: ["other.ts"] });

    expect([...pathsEditedLater(current, [earlier, current, laterLegacy, laterWithEffects, otherThread])].sort()).toEqual([
      "src/effect.ts",
      "src/legacy.ts",
    ]);
  });
});
