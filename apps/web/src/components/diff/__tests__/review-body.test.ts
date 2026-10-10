import { describe, expect, it } from "vitest";
import type { ReviewComparison } from "@mcode/contracts";
import { reviewBody, type ReviewBodyContext } from "../review-body";

const EMPTY: ReviewComparison = { files: [], additions: 0, deletions: 0 };

function context(overrides: Partial<ReviewBodyContext> = {}): ReviewBodyContext {
  return { view: "turn", turnOrdinal: null, branchRange: null, ...overrides };
}

describe("reviewBody", () => {
  it("shows files only when a ready comparison has them", () => {
    const comparison: ReviewComparison = {
      files: [{ path: "a.ts", previousPath: null, changeType: "modified", binary: false, additions: 1, deletions: 0, untracked: false }],
      additions: 1,
      deletions: 0,
    };

    expect(reviewBody({ status: "ready", comparison }, context())).toEqual({ kind: "ready", comparison });
  });

  it.each<[ReviewBodyContext, string]>([
    [context({ view: "turn", turnOrdinal: 4 }), "No file changes in Turn 4"],
    [context({ view: "turn" }), "No file changes in this turn"],
    [context({ view: "cumulative" }), "No file changes in this thread yet"],
    [context({ view: "unstaged" }), "No unstaged changes"],
    [context({ view: "staged" }), "Nothing staged"],
    [context({ view: "commit" }), "No file changes in this commit"],
    [context({ view: "branch", branchRange: { base: "main", target: "feat/x" } }), "No changes between feat/x and main"],
  ])("names what is empty for %o", (ctx, title) => {
    expect(reviewBody({ status: "ready", comparison: EMPTY }, ctx)).toMatchObject({ kind: "empty", title });
  });

  it("keeps a server failure's summary and detail", () => {
    expect(reviewBody(
      { status: "failed", failure: { kind: "timeout", summary: "git diff timed out", detail: "after 15s" } },
      context(),
    )).toEqual({ kind: "failed", summary: "git diff timed out", detail: "after 15s" });
  });

  it("reads a request that never answered as a failure, not as empty", () => {
    expect(reviewBody({ status: "request-failed", detail: "socket closed" }, context()))
      .toEqual({ kind: "failed", summary: "The request didn't complete", detail: "socket closed" });
  });

  it("reports the file count and limit when there are too many files", () => {
    expect(reviewBody({ status: "too-many-files", fileCount: 12_000, limit: 10_000 }, context()))
      .toEqual({ kind: "too-many-files", fileCount: 12_000, limit: 10_000 });
  });

  it.each<[ReviewBodyContext, "snapshot-expired" | "snapshot-pruned", string, string]>([
    [context({ turnOrdinal: 2 }), "snapshot-expired", "Turn 2's changes are gone", "Snapshots older than 30 days are cleared"],
    [context(), "snapshot-pruned", "This turn's changes are gone", "Git removed this turn's snapshot"],
    [context({ view: "cumulative" }), "snapshot-expired", "This thread's changes are gone", "Snapshots older than 30 days are cleared"],
  ])("names gone changes for %o (%s)", (ctx, reason, title, detail) => {
    expect(reviewBody({ status: "unavailable", reason }, ctx)).toEqual({ kind: "gone", title, detail });
  });

  it.each([
    ["unborn", "No commits yet"],
    ["no-base", "No base branch to compare against"],
  ] as const)("reads a repository with %s as empty", (reason, title) => {
    expect(reviewBody({ status: "unavailable", reason }, context({ view: "branch" }))).toEqual({ kind: "empty", title });
  });

  it("names the missing operand for an unselected view", () => {
    expect(reviewBody({ status: "unselected" }, context({ view: "commit" }))).toEqual({ kind: "empty", title: "No commit selected" });
    expect(reviewBody({ status: "unselected" }, context({ view: "turn" }))).toEqual({ kind: "empty", title: "No turns yet" });
  });
});
