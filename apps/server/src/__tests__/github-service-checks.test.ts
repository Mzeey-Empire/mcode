import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorkspaceRepo } from "../repositories/workspace-repo";

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("@mcode/shared", () => ({
  getMcodeDir: () => "/mock/mcode",
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { GithubService } from "../services/github-service";

describe("GithubService.getCheckRuns", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    ghService = new GithubService({} as WorkspaceRepo);
  });

  it("returns passing status when all checks succeed", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "lint", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:08Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("passing");
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].name).toBe("build");
    expect(result.runs[0].conclusion).toBe("success");
    expect(result.runs[0].durationMs).toBe(23000);
  });

  it("returns failing status when any check fails", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", state: "FAILURE", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:45Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[1].conclusion).toBe("failure");
  });

  it("returns pending status when any check is in progress", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", state: "PENDING", startedAt: "2026-04-14T10:00:00Z", completedAt: null },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("pending");
    expect(result.runs[1].status).toBe("in_progress");
    expect(result.runs[1].durationMs).toBeNull();
  });

  it("returns pending status when a check is queued", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "deploy", state: "QUEUED", startedAt: null, completedAt: null },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("pending");
    expect(result.runs[0].status).toBe("queued");
    expect(result.runs[0].conclusion).toBeNull();
    expect(result.runs[0].durationMs).toBeNull();
  });

  it("returns no_checks when array is empty", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "[]");
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });

  it("maps ACTION_REQUIRED state to failing aggregate and failure conclusion", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "security-check", state: "ACTION_REQUIRED", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:10Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[0].conclusion).toBe("failure");
    expect(result.runs[0].status).toBe("completed");
  });

  it("maps STALE state to cancelled conclusion without affecting passing aggregate", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", state: "SUCCESS", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "old-check", state: "STALE", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:05Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("passing");
    expect(result.runs[1].conclusion).toBe("cancelled");
    expect(result.runs[1].status).toBe("completed");
  });

  it("returns no_checks on gh CLI error", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("gh not found"));
      },
    );

    const result = await ghService.getCheckRuns(42, "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });
});

type CallbackFn = (error: Error | null, stdout: string, stderr: string) => void;

describe("GithubService.resolveRepoSlug", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    ghService = new GithubService({} as WorkspaceRepo);
  });

  it("returns owner/repo from gh repo view", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, args: string[], _opts: unknown, cb: CallbackFn) => {
      expect(args).toContain("repo");
      expect(args).toContain("view");
      cb(null, "owner/my-repo\n", "");
    });
    const slug = await ghService.resolveRepoSlug("/some/repo");
    expect(slug).toBe("owner/my-repo");
  });

  it("caches the slug per repoPath", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(null, "owner/cached-repo\n", "");
    });
    await ghService.resolveRepoSlug("/cached");
    const slug = await ghService.resolveRepoSlug("/cached");
    expect(slug).toBe("owner/cached-repo");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("throws when gh repo view fails", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(new Error("not a git repo"), "", "");
    });
    await expect(ghService.resolveRepoSlug("/bad")).rejects.toThrow();
  });

  it("deduplicates concurrent calls for the same path", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      callCount++;
      setImmediate(() => cb(null, "owner/dedup-repo\n", ""));
    });
    const [slug1, slug2] = await Promise.all([
      ghService.resolveRepoSlug("/dedup"),
      ghService.resolveRepoSlug("/dedup"),
    ]);
    expect(slug1).toBe("owner/dedup-repo");
    expect(slug2).toBe("owner/dedup-repo");
    expect(callCount).toBe(1);
  });
});
