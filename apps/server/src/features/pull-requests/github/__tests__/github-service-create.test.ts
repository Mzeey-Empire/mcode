import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { GithubService } from "../github-service.js";
import { GitRepositoryService } from "../../../projects/git/git-repository-service.js";
import { GithubPullRequestClient } from "../github-pull-request-client.js";

const gitRepository = new GitRepositoryService({ findById: () => undefined }, {
  exec: async () => { throw new Error("Unexpected git command"); },
});
const pullRequestClient = new GithubPullRequestClient();

const TEST_HOST_RUNTIME = { platform: "win32", architecture: "x64", nodeAbi: "127" } as const;

describe("GithubService.createPr", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    ghService = new GithubService({ findById: () => undefined }, TEST_HOST_RUNTIME, gitRepository, pullRequestClient);
  });

  it("requests and returns the branch PR title without relying on a picker cache", async () => {
    const info = { number: 42, title: "Paged targets", url: "https://github.com/o/r/pull/42", state: "OPEN" };
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: (error: null, stdout: string) => void) => {
        callback(null, JSON.stringify(info));
      },
    );
    expect(await ghService.getBranchPr("feature", "/repo")).toEqual(info);
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual(["pr", "view", "feature", "--json", "number,title,url,state"]);
  });

  it("creates a PR and returns number and url", async () => {
    // gh pr create outputs the PR URL to stdout (no --json flag supported)
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: (error: null, stdout: string) => void) => {
        callback(null, "https://github.com/o/r/pull/42\n");
      },
    );

    const result = await ghService.createPr({
      cwd: "/repo",
      title: "feat: add widget",
      body: "## What\nAdded widget",
      baseBranch: "main",
      isDraft: false,
    });

    expect(result).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      [
        "pr", "create",
        "--title", "feat: add widget",
        "--body", "## What\nAdded widget",
        "--base", "main",
      ],
      expect.any(Object),
      expect.any(Function),
    );
    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain("--draft");
    expect(callArgs).not.toContain("--json");
  });

  it("passes --draft flag when isDraft is true", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: (error: null, stdout: string) => void) => {
        callback(null, "https://github.com/o/r/pull/7\n");
      },
    );

    await ghService.createPr({
      cwd: "/repo",
      title: "feat: draft feature",
      body: "WIP",
      baseBranch: "main",
      isDraft: true,
    });

    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["--draft"]),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("rejects when gh CLI returns an error", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: (error: Error, stdout: string) => void) => {
        callback(new Error("gh: not authenticated"), "");
      },
    );

    await expect(
      ghService.createPr({
        cwd: "/repo",
        title: "feat: add widget",
        body: "body",
        baseBranch: "main",
        isDraft: false,
      }),
    ).rejects.toThrow("gh: not authenticated");
  });

  it("rejects when gh returns output that does not contain a PR URL", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: (err: null, stdout: string) => void) => {
        callback(null, "some unexpected output");
      },
    );

    await expect(
      ghService.createPr({
        cwd: "/repo",
        title: "test",
        body: "test",
        baseBranch: "main",
        isDraft: false,
      }),
    ).rejects.toThrow("Unexpected gh pr create output");
  });

  it("handles preamble warning lines before the PR URL", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: object, callback: (err: null, stdout: string) => void) => {
        callback(null, "Warning: 2 uncommitted changes\nCreating pull request for feat/thing into main in o/r\nhttps://github.com/o/r/pull/42\n");
      },
    );

    const result = await ghService.createPr({
      cwd: "/repo",
      title: "feat: add widget",
      body: "body",
      baseBranch: "main",
      isDraft: false,
    });

    expect(result).toEqual({ number: 42, url: "https://github.com/o/r/pull/42" });
  });
});
