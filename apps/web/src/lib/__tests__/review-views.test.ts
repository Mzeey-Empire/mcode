import { describe, it, expect } from "vitest";
import type { ReviewState, ReviewTurn, TurnSnapshot } from "@mcode/contracts";
import {
  REVIEW_VIEW_GROUPS,
  REVIEW_VIEWS,
  defaultReviewView,
  reviewViewAvailability,
  sinceLookedMessageIds,
  sinceLookedTurnsLabel,
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

function snapshot(messageId: string, sequence: number, overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    id: `snap-${messageId}`,
    message_id: messageId,
    thread_id: "thread-1",
    ref_before: "before",
    ref_after: "after",
    files_changed: ["a.ts"],
    worktree_path: null,
    created_at: "2026-09-20T10:00:00Z",
    attempt_count: 1,
    reverted_paths: [],
    message_sequence: sequence,
    ...overrides,
  };
}

const NOTHING_NEW = "Nothing new since you looked";

function reasons(map: ReviewViewAvailabilityMap): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(map).map(([id, availability]) => [id, availability.available ? null : availability.reason]),
  );
}

describe("REVIEW_VIEW_GROUPS", () => {
  it("lists seven views in three menu groups with their names", () => {
    expect(REVIEW_VIEW_GROUPS.map((group) => group.map((view) => [view.id, view.label]))).toEqual([
      [["turn", "Turn"], ["since-looked", "Since you looked"], ["cumulative", "All turns"]],
      [["unstaged", "Unstaged"], ["staged", "Staged"]],
      [["commit", "Commit"], ["branch", "Branch"]],
    ]);
    expect(REVIEW_VIEWS.map((view) => view.id))
      .toEqual(["turn", "since-looked", "cumulative", "unstaged", "staged", "commit", "branch"]);
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
  it("makes every view available in a thread with turns, a full git state, and changes since the baseline", () => {
    const sinceLooked = { baseline: 2, snapshots: [snapshot("msg-1", 4)] };
    expect(reasons(reviewViewAvailability("thread", gitState(), [TURN], sinceLooked))).toEqual({
      turn: null, "since-looked": null, cumulative: null, unstaged: null, staged: null, commit: null, branch: null,
    });
  });

  it("dims the turn views outside a thread", () => {
    const map = reasons(reviewViewAvailability("threadless", gitState(), null));
    expect(map.turn).toBe("Open a thread to review its turns");
    expect(map.cumulative).toBe("Open a thread to review its turns");
    expect(reasons(reviewViewAvailability("threadless", gitState(), null, { baseline: 2, snapshots: undefined }))["since-looked"])
      .toBe("Open a thread to review its turns");
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
      "since-looked": NOTHING_NEW,
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
    expect(reasons(reviewViewAvailability("thread", null, null, { baseline: 0, snapshots: undefined }))).toEqual({
      turn: null, "since-looked": null, cumulative: null, unstaged: null, staged: null, commit: null, branch: null,
    });
  });

  it("dims Since you looked without a baseline for this visit", () => {
    const sinceLooked = { baseline: null, snapshots: [snapshot("msg-1", 4)] };
    expect(reasons(reviewViewAvailability("thread", gitState(), [TURN], sinceLooked))["since-looked"]).toBe(NOTHING_NEW);
  });

  it("makes Since you looked available only for a turn with changes settled after the baseline", () => {
    const availability = (baseline: number, snapshots: TurnSnapshot[]) =>
      reasons(reviewViewAvailability("thread", gitState(), [TURN], { baseline, snapshots }))["since-looked"];
    expect(availability(4, [snapshot("msg-1", 4)])).toBe(NOTHING_NEW);
    expect(availability(3, [snapshot("msg-1", 4)])).toBeNull();
    expect(availability(2, [snapshot("msg-1", 4, { files_changed: [] })])).toBe(NOTHING_NEW);
    expect(availability(0, [])).toBe(NOTHING_NEW);
  });

  it("counts a retried turn whose latest attempt changed nothing", () => {
    const retried = snapshot("msg-2", 6, { files_changed: [], attempt_count: 2 });
    expect(reasons(reviewViewAvailability("thread", gitState(), [TURN], { baseline: 4, snapshots: [retried] }))["since-looked"])
      .toBeNull();
  });
});

describe("Since you looked turns", () => {
  const turns: ReviewTurn[] = [3, 4, 5].map((ordinal) => ({ ...TURN, messageId: `msg-${ordinal}`, ordinal }));

  it("names the turns settled after the baseline with changes", () => {
    const snapshots = [
      snapshot("msg-3", 6),
      snapshot("msg-4", 8, { files_changed: [] }),
      snapshot("msg-5", 10),
    ];
    expect(sinceLookedMessageIds(snapshots, 6)).toEqual(["msg-5"]);
    expect(sinceLookedTurnsLabel(turns, sinceLookedMessageIds(snapshots, 6))).toBe("Turn 5");
    expect(sinceLookedTurnsLabel(turns, sinceLookedMessageIds(snapshots, 0))).toBe("Turns 3–5");
  });

  it("has no label when no message names a listed turn", () => {
    expect(sinceLookedTurnsLabel(turns, ["msg-9"])).toBeNull();
    expect(sinceLookedTurnsLabel(turns, [])).toBeNull();
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

  it("never returns Since you looked or an unavailable view when any other view can load", () => {
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
    const sinceLookedInputs = [
      { baseline: null, snapshots: undefined },
      { baseline: 0, snapshots: undefined },
      { baseline: 0, snapshots: [snapshot("msg-1", 2)] },
    ];
    const cases = (["thread", "threadless"] as const).flatMap((scope) =>
      states.flatMap((state) => turnLists.flatMap((turns) => sinceLookedInputs.flatMap((sinceLooked) =>
        changeStates.map((changeState) => ({ scope, state, turns, sinceLooked, changeState }))))));
    for (const { scope, state, turns, sinceLooked, changeState } of cases) {
      const availability = reviewViewAvailability(scope, state, turns, sinceLooked);
      const anyAvailable = REVIEW_VIEWS.some((view) => view.id !== "since-looked" && availability[view.id].available);
      const picked: DiffViewMode = defaultReviewView(scope, changeState, availability);
      expect(picked).not.toBe("since-looked");
      if (anyAvailable) expect(availability[picked].available).toBe(true);
    }
  });

  it("returns Unstaged when nothing can load", () => {
    const nothing = reviewViewAvailability("threadless", { isGitRepo: false }, null);
    expect(defaultReviewView("threadless", clean, nothing)).toBe("unstaged");
  });
});
