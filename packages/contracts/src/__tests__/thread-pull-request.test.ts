import { describe, expect, it } from "vitest";
import { createMockThreadPullRequest } from "../testing.js";
import { pullRequestsSettledMerged, rankPullRequests } from "../models/thread-pull-request.js";

describe("thread pull requests", () => {
  it("ranks open, draft, unresolved, merged and closed, then newer numbers first", () => {
    const prs = [
      createMockThreadPullRequest({ number: 1, state: "closed" }),
      createMockThreadPullRequest({ number: 2, state: "merged" }),
      createMockThreadPullRequest({ number: 3, state: "unresolved" }),
      createMockThreadPullRequest({ number: 4, state: "draft" }),
      createMockThreadPullRequest({ number: 5, state: "open" }),
      createMockThreadPullRequest({ number: 6, state: "open" }),
    ];
    expect(rankPullRequests(prs).map((pr) => pr.number)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(prs.map((pr) => pr.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each([
    { states: ["merged", "closed"], expected: false },
    { states: ["merged", "merged"], expected: true },
    { states: ["merged", "unresolved"], expected: false },
    { states: [], expected: false },
  ] satisfies Array<{ states: Array<"merged" | "closed" | "unresolved">; expected: boolean }>)
    ("requires a nonempty all-merged set: $states", ({ states, expected }) => {
      expect(pullRequestsSettledMerged(states.map((state) => createMockThreadPullRequest({ state })))).toBe(expected);
    });
});
