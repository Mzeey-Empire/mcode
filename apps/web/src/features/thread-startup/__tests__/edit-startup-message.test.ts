import type { ThreadStartup } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { startupRetryTarget } from "../edit-startup-message";

const managed = { mode: "worktree", branch: "mcode-3f2a", base_branch: "main", worktree_managed: true, worktree_path: "/w/mcode-3f2a" } as const;

function withFetch(detail: Extract<NonNullable<ThreadStartup["steps"][number]["detail"]>, { phase: "fetch" }>): Pick<ThreadStartup, "steps"> {
  return { steps: [{ phase: "fetch", state: "completed", detail }, { phase: "thread", state: "completed" }] };
}

describe("startupRetryTarget", () => {
  it("reopens a managed worktree on its base branch when nothing was fetched", () => {
    expect(startupRetryTarget(managed, { steps: [{ phase: "thread", state: "completed" }] })).toEqual({
      mode: "worktree", branch: "main", branchSource: "branch", branchRemote: null, startFromOrigin: false, selectedWorktree: null,
    });
  });

  it("keeps Start from origin when the startup fetched the base branch", () => {
    expect(startupRetryTarget(managed, withFetch({ phase: "fetch", ref: "origin/main", branch: "main" }))).toEqual({
      mode: "worktree", branch: "main", branchSource: "branch", branchRemote: null, startFromOrigin: true, selectedWorktree: null,
    });
  });

  it("keeps the pull request a startup fetched", () => {
    expect(startupRetryTarget(managed, withFetch({ phase: "fetch", ref: "pull/1804/head", branch: "feat/trail", pullRequestNumber: 1804 }))).toEqual({
      mode: "worktree", branch: "feat/trail", branchSource: "pr", pullRequestNumber: 1804, branchRemote: null, startFromOrigin: false, selectedWorktree: null,
    });
  });
});
