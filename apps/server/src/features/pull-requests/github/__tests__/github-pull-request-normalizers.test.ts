import { describe, expect, it } from "vitest";
import { normalizeThreadPullRequestState, parseGithubBranchPullRequests, parseGithubThreadPullRequest } from "../github-pull-request-normalizers.js";

describe("thread PR normalization", () => {
  it("maps an open draft to draft while a merged draft stays merged", () => {
    expect(normalizeThreadPullRequestState("OPEN", true)).toBe("draft");
    expect(normalizeThreadPullRequestState("MERGED", true)).toBe("merged");
    expect(normalizeThreadPullRequestState("CLOSED", true)).toBe("closed");
  });

  it("normalizes GitHub state and bounds the PR title at the boundary", () => {
    expect(parseGithubThreadPullRequest({ number: 7, state: "MERGED", isDraft: false,
      title: "x".repeat(600), url: "https://github.com/o/r/pull/7" }))
      .toEqual({ number: 7, state: "merged", title: "x".repeat(512), url: "https://github.com/o/r/pull/7" });
  });

  it("rejects malformed GitHub states and missing draft metadata", () => {
    expect(parseGithubThreadPullRequest({ number: 7, state: "UNKNOWN", isDraft: false, title: "Feature", url: "https://github.com/o/r/pull/7" })).toBeNull();
    expect(parseGithubThreadPullRequest({ number: 7, state: "OPEN", title: "Feature", url: "https://github.com/o/r/pull/7" })).toBeNull();
  });

  it("keeps PRs from every page of branch discovery", () => {
    const pages = [
      { data: { repository: { pullRequests: { nodes: [
        { number: 1, state: "OPEN", isDraft: true, title: "Draft feature", url: "https://github.com/o/r/pull/1", headRepository: { nameWithOwner: "o/r" } },
      ] } } } },
      { data: { repository: { pullRequests: { nodes: [
        { number: 2, state: "MERGED", isDraft: false, title: "Merged feature", url: "https://github.com/o/r/pull/2", headRepository: { nameWithOwner: "o/r" } },
      ] } } } },
    ];
    expect(parseGithubBranchPullRequests(pages, "o/r")).toEqual([
      { number: 1, state: "draft", title: "Draft feature", url: "https://github.com/o/r/pull/1" },
      { number: 2, state: "merged", title: "Merged feature", url: "https://github.com/o/r/pull/2" },
    ]);
    expect(() => parseGithubBranchPullRequests([{ data: { repository: null } }], "o/r")).toThrow();
  });
});
