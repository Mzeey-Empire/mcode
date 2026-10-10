import { describe, expect, it } from "vitest";
import { GIT_COMMIT_MAX_PATHS, WS_METHODS } from "../index.js";

const commit = WS_METHODS()["git.commit"];
const generate = WS_METHODS()["git.generateCommitMessage"];

const validCommit = {
  workspaceId: "project",
  requestId: "3f2a9c1e-8d4b-4a6f-9e2d-1c0b7a5e4d3f",
  expectedHead: "a".repeat(40),
  files: [{ path: "src/new.ts", previousPath: "src/old.ts" }],
  message: "  feat: add thing\n\nBody  ",
  push: false,
};

describe("git.commit params", () => {
  it("trims the message and keeps rename pairs", () => {
    expect(commit.params.parse(validCommit)).toMatchObject({
      message: "feat: add thing\n\nBody",
      files: [{ path: "src/new.ts", previousPath: "src/old.ts" }],
    });
  });

  it("accepts an unborn expectedHead", () => {
    expect(commit.params.safeParse({ ...validCommit, expectedHead: null }).success).toBe(true);
  });

  it.each([
    ["a whitespace-only message", { message: "   \n " }],
    ["a non-uuid requestId", { requestId: "click-1" }],
    ["an abbreviated expectedHead", { expectedHead: "abc1234" }],
    ["no files", { files: [] }],
    ["too many files", { files: Array.from({ length: GIT_COMMIT_MAX_PATHS + 1 }, (_, index) => ({ path: `f${index}`, previousPath: null })) }],
  ])("rejects %s", (_label, override) => {
    expect(commit.params.safeParse({ ...validCommit, ...override }).success).toBe(false);
  });
});

describe("git.commit result", () => {
  it("keeps the push outcome separate from a committed result", () => {
    const result = {
      status: "committed",
      sha: "b".repeat(40),
      shortSha: "bbbbbbb",
      branch: "main",
      push: { status: "failed", summary: "Push rejected", detail: "! [rejected]" },
    };
    expect(commit.result.parse(result)).toEqual(result);
  });

  it("rejects an unknown rejection kind", () => {
    expect(commit.result.safeParse({ status: "rejected", reason: { kind: "hook" } }).success).toBe(false);
  });
});

describe("git.generateCommitMessage", () => {
  it("has no success shape without a model", () => {
    expect(generate.result.safeParse({ status: "ok", subject: "feat: x", body: "" }).success).toBe(false);
  });

  it("rejects an empty path list", () => {
    expect(generate.params.safeParse({ workspaceId: "project", paths: [] }).success).toBe(false);
  });
});
