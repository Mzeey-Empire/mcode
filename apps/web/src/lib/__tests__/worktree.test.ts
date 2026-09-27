import { describe, it, expect } from "vitest";
import { resolveThreadDirPath } from "../worktree";

describe("resolveThreadDirPath", () => {
  it("returns the worktree path for a worktree thread", () => {
    expect(
      resolveThreadDirPath(
        { mode: "worktree", worktree_path: "/repo/worktrees/feat-x" },
        "/repo",
      ),
    ).toBe("/repo/worktrees/feat-x");
  });

  it("returns null for a worktree thread whose worktree path is not yet provisioned", () => {
    expect(
      resolveThreadDirPath({ mode: "worktree", worktree_path: null }, "/repo"),
    ).toBeNull();
  });

  it("falls back to the workspace checkout for a direct thread", () => {
    expect(
      resolveThreadDirPath({ mode: "direct", worktree_path: null }, "/repo"),
    ).toBe("/repo");
  });

  it("prefers a direct thread's worktree path when present", () => {
    expect(
      resolveThreadDirPath(
        { mode: "direct", worktree_path: "/repo/worktrees/feat-x" },
        "/repo",
      ),
    ).toBe("/repo/worktrees/feat-x");
  });

  it("returns null when no workspace is available", () => {
    expect(
      resolveThreadDirPath({ mode: "direct", worktree_path: null }, null),
    ).toBeNull();
  });
});
