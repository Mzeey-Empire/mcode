import { describe, expect, it } from "vitest";
import { WS_METHODS } from "../index.js";

const method = WS_METHODS()["git.refs.list"];

describe("git.refs.list", () => {
  it.each([
    { purpose: "review" },
    { purpose: "new-thread", side: "local" },
    { purpose: "existing-worktree", side: "origin" },
    { purpose: "review", side: "upstream" },
  ])("rejects invalid purpose/side input %j", (input) => {
    expect(method.params.safeParse({ workspaceId: "project", ...input }).success).toBe(false);
  });

  it.each(["local", "origin"])("accepts review side %s and defaults the page limit", (side) => {
    expect(method.params.parse({ workspaceId: "project", purpose: "review", side, query: " Feature " })).toEqual({
      workspaceId: "project", purpose: "review", side, query: "Feature", limit: 50,
    });
  });

  it.each(["new-thread", "existing-worktree"])("accepts %s without a side", (purpose) => {
    expect(method.params.parse({ workspaceId: "project", purpose })).toEqual({ workspaceId: "project", purpose, limit: 50 });
  });

  it("preserves full refs, worktree metadata, totals and cursor", () => {
    const page = { ok: true, total: 125, nextCursor: "opaque", items: [{
      kind: "ref", fullName: "refs/heads/feature/x", shortName: "feature/x", branchName: "feature/x",
      remote: null, twin: "refs/remotes/origin/feature/x", isCurrent: false, isDefault: false,
      worktree: { path: "/repo/linked", folder: "linked" }, headSha: "a".repeat(40), committedAt: "2026-10-01T10:00:00.000Z",
    }, { kind: "detached-worktree", worktree: { path: "/repo/detached", folder: "detached" }, headShortSha: "abcdef0" }] };
    expect(method.result.parse(page)).toEqual(page);
    expect(method.result.safeParse({ ...page, total: -1 }).success).toBe(false);
    expect(method.result.safeParse({ ...page, items: Array.from({ length: 101 }, () => page.items[0]) }).success).toBe(false);
    expect(method.params.safeParse({ workspaceId: "project", purpose: "new-thread", limit: 101 }).success).toBe(false);
  });

  it.each(["not_a_repository", "git_failed", "timed_out"])("preserves the %s failure", (code) => {
    const failure = { ok: false, error: { code, message: "Could not list targets", detail: "fatal: bad object refs/heads/broken" } };
    expect(method.result.parse(failure)).toEqual(failure);
    expect(method.result.safeParse([]).success).toBe(false);
  });
});
