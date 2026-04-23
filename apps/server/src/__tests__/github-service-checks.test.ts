import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

type CallbackFn = (error: Error | null, stdout: string, stderr: string) => void;

describe("GithubService.getCheckRuns", () => {
  let ghService: GithubService;

  beforeEach(() => {
    vi.clearAllMocks();
    ghService = new GithubService({} as WorkspaceRepo);
    vi.spyOn(ghService, "resolveRepoSlug").mockResolvedValue("owner/test-repo");
  });

  it("returns passing status when all checks succeed", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "lint", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:08Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

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
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", status: "completed", conclusion: "failure", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:45Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[1].conclusion).toBe("failure");
  });

  it("returns pending status when any check is in progress", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "test", status: "in_progress", conclusion: null, startedAt: "2026-04-14T10:00:00Z", completedAt: null },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("pending");
    expect(result.runs[1].status).toBe("in_progress");
    expect(result.runs[1].durationMs).toBeNull();
  });

  it("returns pending status when a check is queued", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "deploy", status: "queued", conclusion: null, startedAt: null, completedAt: null },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

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

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });

  it("maps action_required conclusion to failing aggregate and failure conclusion", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "security-check", status: "completed", conclusion: "action_required", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:10Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[0].conclusion).toBe("failure");
    expect(result.runs[0].status).toBe("completed");
  });

  it("maps cancelled conclusion without affecting passing aggregate", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          { name: "old-check", status: "completed", conclusion: "cancelled", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:05Z" },
        ]));
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

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

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
  });

  it("limits concurrent gh subprocesses to 3", async () => {
    let activeCount = 0;
    let peakActive = 0;
    const resolvers: Array<() => void> = [];

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        activeCount++;
        peakActive = Math.max(peakActive, activeCount);
        // Push a resolver instead of using setImmediate so the test controls exactly when each
        // subprocess "completes". This removes timing non-determinism from the assertion.
        resolvers.push(() => {
          activeCount--;
          cb(null, JSON.stringify([
            { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          ]), "");
        });
      },
    );

    // Start 5 concurrent calls with distinct branches so the in-flight dedup does not
    // collapse them - each needs its own execFile slot to exercise the gate properly.
    const promises = Array.from({ length: 5 }, (_, i) => ghService.getCheckRuns(`branch-${i}`, "/repo"));

    // Drain the microtask queue until the gate is saturated (3 execFile calls in-flight).
    while (resolvers.length < 3) {
      await Promise.resolve();
    }
    expect(peakActive).toBe(3);

    // Complete each in-flight call one at a time; each release lets a queued call start.
    while (resolvers.length > 0) {
      resolvers.shift()!();
      await Promise.resolve(); // allow the next queued caller to acquire the slot
    }

    await Promise.all(promises);
    // Peak never exceeded the gate limit throughout the entire run.
    expect(peakActive).toBe(3);
  });

  // C1: Empty branch guard
  it("resolves to no_checks when branch is empty string", async () => {
    const result = await ghService.getCheckRuns("", "/repo");

    expect(result.aggregate).toBe("no_checks");
    expect(result.runs).toHaveLength(0);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // H1: Unknown conclusion treated conservatively as failure
  it("treats unknown conclusion as failure to be conservative", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "ci", status: "completed", conclusion: "startup_failure", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:05Z" },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.aggregate).toBe("failing");
    expect(result.runs[0].conclusion).toBe("failure");
  });

  // M1: Missing status defaults to in_progress
  it("treats missing status as in_progress to avoid false passing aggregate", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "ci", conclusion: null, startedAt: null, completedAt: null },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo");

    expect(result.runs[0].status).toBe("in_progress");
    expect(result.aggregate).toBe("pending");
  });

  // M3: Concurrency gate not stuck after failure
  it("releases concurrency slot even after a failed getCheckRuns call", async () => {
    // First 3 calls fail (simulating errors)
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        callCount++;
        setImmediate(() => {
          cb(new Error("gh error"), "", "");
        });
      },
    );

    // Fire 3 failing calls
    await Promise.all([
      ghService.getCheckRuns("main", "/repo"),
      ghService.getCheckRuns("main", "/repo2"),
      ghService.getCheckRuns("main", "/repo3"),
    ]);

    // 4th call should succeed - gate not stuck
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        cb(null, JSON.stringify([
          { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
        ]), "");
      },
    );

    const result = await ghService.getCheckRuns("main", "/repo4");
    expect(result.aggregate).toBe("passing");
  });

  // M6: In-flight deduplication for identical branch+repo pairs
  it("deduplicates concurrent getCheckRuns for same branch+repo", async () => {
    let execFileCallCount = 0;

    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
        execFileCallCount++;
        setImmediate(() => {
          cb(null, JSON.stringify([
            { name: "build", status: "completed", conclusion: "success", startedAt: "2026-04-14T10:00:00Z", completedAt: "2026-04-14T10:00:23Z" },
          ]), "");
        });
      },
    );

    const [result1, result2] = await Promise.all([
      ghService.getCheckRuns("main", "/repo"),
      ghService.getCheckRuns("main", "/repo"),
    ]);

    expect(execFileCallCount).toBe(1);
    expect(result1.aggregate).toBe("passing");
    expect(result2.aggregate).toBe("passing");
  });
});

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

  // H2: Slug cache TTL - re-fetches after expiry
  it("re-fetches slug after TTL expires", async () => {
    vi.useFakeTimers();

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(null, "owner/ttl-repo\n", "");
    });

    // First call populates cache
    await ghService.resolveRepoSlug("/ttl-repo");
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    // Advance past 30-minute TTL
    vi.advanceTimersByTime(31 * 60 * 1000);

    // Second call after TTL should re-fetch
    await ghService.resolveRepoSlug("/ttl-repo");
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  // M2: Malformed slug rejected
  it("throws when gh repo view returns malformed output", async () => {
    mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: CallbackFn) => {
      cb(null, "not-a-slug\n", "");
    });
    await expect(ghService.resolveRepoSlug("/malformed")).rejects.toThrow("Unexpected slug format");
  });
});
