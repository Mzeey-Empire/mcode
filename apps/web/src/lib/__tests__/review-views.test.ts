import { describe, it, expect } from "vitest";
import type { ReviewState, ReviewTurn } from "@mcode/contracts";
import {
  REVIEW_VIEW_GROUPS,
  REVIEW_VIEWS,
  defaultReviewView,
  reviewViewAvailability,
  type ReviewChangeState,
  type ReviewViewAvailabilityMap,
} from "../review-views";
import type { DiffViewMode } from "@/stores/diffStore";

type GitState = Extract<ReviewState, { isGitRepo: true }>;

function gitState(overrides: Partial<GitState> = {}): GitState {
  return {
    isGitRepo: true,
    head: "abc123",
    branch: "feature",
    uncommitted: { staged: 1, unstaged: 1, untracked: 0 },
    commitsAhead: { count: 2, base: "main" },
    branchDefault: { compare: "feature", base: "main" },
    ...overrides,
  };
}

const TURN: ReviewTurn = {
  messageId: "msg-1",
  ordinal: 1,
  createdAt: "2026-09-20T10:00:00Z",
  phase: "settled",
  fileCount: 1,
  additions: 1,
  deletions: 0,
  evidence: "native",
  availability: "available",
};

function reasons(map: ReviewViewAvailabilityMap): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(map).map(([id, availability]) => [id, availability.available ? null : availability.reason]),
  );
}

describe("REVIEW_VIEW_GROUPS", () => {
  it("lists six views in three menu groups with their names", () => {
    expect(REVIEW_VIEW_GROUPS.map((group) => group.map((view) => [view.id, view.label]))).toEqual([
      [["turn", "Turn"], ["cumulative", "All turns"]],
      [["unstaged", "Unstaged"], ["staged", "Staged"]],
      [["commit", "Commit"], ["branch", "Branch"]],
    ]);
    expect(REVIEW_VIEWS.map((view) => view.id)).toEqual(["turn", "cumulative", "unstaged", "staged", "commit", "branch"]);
  });

  it("carries a picked operand only on Turn, Commit and Branch", () => {
    expect(REVIEW_VIEWS.filter((view) => view.operand).map((view) => [view.id, view.operand])).toEqual([
      ["turn", "turn"],
      ["commit", "commit"],
      ["branch", "branch"],
    ]);
  });
});

describe("reviewViewAvailability", () => {
  it("makes every view available in a thread with turns and a full git state", () => {
    expect(reasons(reviewViewAvailability("thread", gitState(), [TURN]))).toEqual({
      turn: null, cumulative: null, unstaged: null, staged: null, commit: null, branch: null,
    });
  });

  it("dims the turn views outside a thread", () => {
    const map = reasons(reviewViewAvailability("threadless", gitState(), null));
    expect(map.turn).toBe("Open a thread to review its turns");
    expect(map.cumulative).toBe("Open a thread to review its turns");
  });

  it("dims the turn views in a thread without turns", () => {
    const map = reasons(reviewViewAvailability("thread", gitState(), []));
    expect(map.turn).toBe("No turns yet");
    expect(map.cumulative).toBe("No turns yet");
  });

  it("dims every git view outside a git repository", () => {
    const map = reasons(reviewViewAvailability("thread", { isGitRepo: false }, [TURN]));
    expect(map).toEqual({
      turn: null,
      cumulative: null,
      unstaged: "Not a git repository",
      staged: "Not a git repository",
      commit: "Not a git repository",
      branch: "Not a git repository",
    });
  });

  it("dims Staged when nothing is staged", () => {
    const state = gitState({ uncommitted: { staged: 0, unstaged: 3, untracked: 1 } });
    expect(reasons(reviewViewAvailability("thread", state, [TURN])).staged).toBe("Nothing staged");
  });

  it("dims Commit with no commits ahead of the base, or with no base", () => {
    expect(reasons(reviewViewAvailability("thread", gitState({ commitsAhead: { count: 0, base: "main" } }), null)).commit)
      .toBe("No commits ahead of main");
    expect(reasons(reviewViewAvailability("thread", gitState({ commitsAhead: null }), null)).commit)
      .toBe("No branch to compare against");
  });

  it("dims Branch on an unborn repository or without a base", () => {
    expect(reasons(reviewViewAvailability("thread", gitState({ branchDefault: { unavailable: "unborn" } }), null)).branch)
      .toBe("No commits yet");
    expect(reasons(reviewViewAvailability("thread", gitState({ branchDefault: { unavailable: "no-base" } }), null)).branch)
      .toBe("No branch to compare against");
  });

  it("treats unknown inputs as available so a slow probe never dims a view", () => {
    expect(reasons(reviewViewAvailability("thread", null, null))).toEqual({
      turn: null, cumulative: null, unstaged: null, staged: null, commit: null, branch: null,
    });
  });
});

describe("defaultReviewView (ADR-0011)", () => {
  const all = reviewViewAvailability("thread", gitState(), [TURN]);
  const clean: ReviewChangeState = { hasTurnChanges: false, isDirty: false };

  it("opens Turn in a thread with turn changes, even with a dirty checkout", () => {
    expect(defaultReviewView("thread", { hasTurnChanges: true, isDirty: true }, all)).toBe("turn");
  });

  it("opens Unstaged for a dirty checkout without turn changes", () => {
    expect(defaultReviewView("thread", { hasTurnChanges: false, isDirty: true }, all)).toBe("unstaged");
  });

  it("opens Branch for a clean checkout", () => {
    expect(defaultReviewView("thread", clean, all)).toBe("branch");
  });

  it("opens Unstaged when Branch cannot load", () => {
    const noBase = reviewViewAvailability("thread", gitState({ branchDefault: { unavailable: "no-base" } }), [TURN]);
    expect(defaultReviewView("thread", clean, noBase)).toBe("unstaged");
  });

  it("ignores turn changes outside a thread", () => {
    const threadless = reviewViewAvailability("threadless", gitState(), null);
    expect(defaultReviewView("threadless", { hasTurnChanges: true, isDirty: false }, threadless)).toBe("branch");
  });

  it("falls back to the turn views outside a git repository", () => {
    const noGit = reviewViewAvailability("thread", { isGitRepo: false }, [TURN]);
    expect(defaultReviewView("thread", { hasTurnChanges: false, isDirty: true }, noGit)).toBe("turn");
  });

  it("never returns an unavailable view when any view can load", () => {
    const states: readonly (ReviewState | null)[] = [
      null,
      { isGitRepo: false },
      gitState(),
      gitState({ uncommitted: { staged: 0, unstaged: 0, untracked: 0 }, commitsAhead: null, branchDefault: { unavailable: "unborn" } }),
      gitState({ commitsAhead: { count: 0, base: "main" }, branchDefault: { unavailable: "no-base" } }),
    ];
    const turnLists: readonly (readonly ReviewTurn[] | null)[] = [null, [], [TURN]];
    const changeStates: readonly ReviewChangeState[] = [false, true].flatMap((hasTurnChanges) =>
      [false, true].map((isDirty) => ({ hasTurnChanges, isDirty })));
    const cases = (["thread", "threadless"] as const).flatMap((scope) =>
      states.flatMap((state) => turnLists.flatMap((turns) =>
        changeStates.map((changeState) => ({ scope, state, turns, changeState })))));
    for (const { scope, state, turns, changeState } of cases) {
      const availability = reviewViewAvailability(scope, state, turns);
      const anyAvailable = REVIEW_VIEWS.some((view) => availability[view.id].available);
      const picked: DiffViewMode = defaultReviewView(scope, changeState, availability);
      if (anyAvailable) expect(availability[picked].available).toBe(true);
    }
  });

  it("returns Unstaged when nothing can load", () => {
    const nothing = reviewViewAvailability("threadless", { isGitRepo: false }, null);
    expect(defaultReviewView("threadless", clean, nothing)).toBe("unstaged");
  });
});
