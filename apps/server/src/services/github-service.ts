/**
 * GitHub PR operations service.
 * Wraps the `gh` CLI for pull request lookups and listing.
 * Extracted from apps/desktop/src/main/github.ts.
 */

import { injectable, inject } from "tsyringe";
import { execFile } from "child_process";
import type { PrInfo, PrDetail, ChecksStatus, CheckRun } from "@mcode/contracts";
import { WorkspaceRepo } from "../repositories/workspace-repo";

/** Handles GitHub PR lookups and listing via the gh CLI. */
@injectable()
export class GithubService {
  private readonly slugCache = new Map<string, Promise<string>>();

  constructor(
    @inject(WorkspaceRepo) private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  /** Look up the PR associated with a branch in the given working directory. */
  getBranchPr(branch: string, cwd: string): Promise<PrInfo | null> {
    return new Promise((resolve) => {
      execFile(
        "gh",
        ["pr", "view", branch, "--json", "number,url,state"],
        { cwd, encoding: "utf-8", timeout: 10_000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(stdout) as {
              number?: number;
              url?: string;
              state?: string;
            };
            if (
              typeof data.number === "number" &&
              typeof data.url === "string"
            ) {
              resolve({
                number: data.number,
                url: data.url,
                state: data.state ?? "OPEN",
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  /** List open PRs for a workspace's repository. */
  async listOpenPrs(workspaceId: string): Promise<PrDetail[]> {
    const workspace = this.workspaceRepo.findById(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);

    return new Promise((resolve) => {
      execFile(
        "gh",
        [
          "pr",
          "list",
          "--json",
          "number,title,headRefName,author,url,state",
          "--limit",
          "30",
        ],
        { cwd: workspace.path, encoding: "utf-8", timeout: 15_000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve([]);
            return;
          }
          try {
            const items = JSON.parse(stdout) as Array<{
              number?: number;
              title?: string;
              headRefName?: string;
              author?: { login?: string };
              url?: string;
              state?: string;
            }>;
            const results: PrDetail[] = [];
            for (const item of items) {
              if (
                typeof item.number === "number" &&
                typeof item.headRefName === "string"
              ) {
                results.push({
                  number: item.number,
                  title: item.title ?? "",
                  branch: item.headRefName,
                  author: item.author?.login ?? "",
                  url: item.url ?? "",
                  state: item.state ?? "OPEN",
                });
              }
            }
            resolve(results);
          } catch {
            resolve([]);
          }
        },
      );
    });
  }

  /**
   * Create a GitHub pull request via the gh CLI.
   * Returns the new PR's number and URL.
   */
  createPr(input: {
    cwd: string;
    title: string;
    body: string;
    baseBranch: string;
    isDraft: boolean;
  }): Promise<{ number: number; url: string }> {
    const args = [
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      input.body,
      "--base",
      input.baseBranch,
    ];
    if (input.isDraft) {
      args.push("--draft");
    }

    return new Promise((resolve, reject) => {
      execFile(
        "gh",
        args,
        { cwd: input.cwd, encoding: "utf-8", timeout: 30_000 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          // gh pr create outputs the PR URL to stdout, possibly preceded by
          // warning/info lines. Extract the URL from anywhere in the output.
          const prUrlMatch = stdout.match(/https:\/\/[^\s]*\/pull\/(\d+)/);
          if (!prUrlMatch) {
            reject(new Error(`Unexpected gh pr create output: ${stdout.trim()}`));
            return;
          }
          const number = parseInt(prUrlMatch[1], 10);
          const url = prUrlMatch[0];
          resolve({ number, url });
        },
      );
    });
  }

  /**
   * Fetch CI check runs for a branch via the GitHub REST API.
   * Uses `gh api --cache 5s` so ETag conditional requests are sent automatically -
   * 304 Not Modified responses do not count against the 5,000/hr rate limit.
   * Returns aggregate status and individual check details.
   */
  async getCheckRuns(branch: string, repoPath: string): Promise<ChecksStatus> {
    const slug = await this.resolveRepoSlug(repoPath);
    return new Promise((resolve) => {
      execFile(
        "gh",
        [
          "api",
          `repos/${slug}/commits/${encodeURIComponent(branch)}/check-runs`,
          "--cache", "5s",
          "-H", "Accept: application/vnd.github+json",
          "--jq", ".check_runs | map({name: .name, status: .status, conclusion: .conclusion, startedAt: .started_at, completedAt: .completed_at})",
        ],
        { cwd: repoPath, encoding: "utf-8", timeout: 15_000 },
        (error, stdout) => {
          const now = Date.now();
          if (error || !stdout) {
            resolve({ aggregate: "no_checks", runs: [], fetchedAt: now });
            return;
          }
          try {
            const items = JSON.parse(stdout) as Array<{
              name?: string;
              status?: string;
              conclusion?: string | null;
              startedAt?: string | null;
              completedAt?: string | null;
            }>;

            if (items.length === 0) {
              resolve({ aggregate: "no_checks", runs: [], fetchedAt: now });
              return;
            }

            const runs = items.map((item) => {
              const status = (item.status ?? "completed") as CheckRun["status"];
              // action_required blocks merge like a failure; map it accordingly.
              const rawConclusion = item.conclusion ?? null;
              const conclusion: CheckRun["conclusion"] = rawConclusion === "action_required"
                ? "failure"
                : rawConclusion as CheckRun["conclusion"];

              let durationMs: number | null = null;
              if (status === "completed" && item.startedAt && item.completedAt) {
                durationMs = new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime();
              }

              return {
                name: item.name ?? "unknown",
                status,
                conclusion,
                durationMs,
                startedAt: item.startedAt ?? null,
              };
            });

            let aggregate: "passing" | "failing" | "pending" | "no_checks";
            if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out")) {
              aggregate = "failing";
            } else if (runs.some((r) => r.status !== "completed")) {
              aggregate = "pending";
            } else {
              aggregate = "passing";
            }

            // If all runs completed but none succeeded (all skipped/cancelled/neutral),
            // treat as no_checks to avoid a misleading green badge.
            if (aggregate === "passing" && !runs.some((r) => r.conclusion === "success")) {
              aggregate = "no_checks";
            }

            resolve({ aggregate, runs, fetchedAt: now });
          } catch {
            resolve({ aggregate: "no_checks", runs: [], fetchedAt: now });
          }
        },
      );
    });
  }

  /** Resolve the GitHub owner/repo slug for a local repository path. Cached per path. */
  resolveRepoSlug(repoPath: string): Promise<string> {
    const cached = this.slugCache.get(repoPath);
    if (cached) return cached;

    const pending = new Promise<string>((resolve, reject) => {
      execFile(
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        { cwd: repoPath, encoding: "utf-8", timeout: 10_000 },
        (error, stdout) => {
          if (error || !stdout.trim()) {
            this.slugCache.delete(repoPath); // evict so next call can retry
            reject(error ?? new Error("Failed to resolve repo slug"));
            return;
          }
          resolve(stdout.trim());
        },
      );
    });

    this.slugCache.set(repoPath, pending);
    return pending;
  }

  /** Look up a PR by its GitHub URL. */
  getPrByUrl(url: string): Promise<PrDetail | null> {
    const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) return Promise.resolve(null);

    const repo = match[1];
    const prNumber = match[2];

    return new Promise((resolve) => {
      execFile(
        "gh",
        [
          "pr",
          "view",
          prNumber,
          "--repo",
          repo,
          "--json",
          "number,title,headRefName,author,url,state",
        ],
        { encoding: "utf-8", timeout: 15_000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(null);
            return;
          }
          try {
            const data = JSON.parse(stdout) as {
              number?: number;
              title?: string;
              headRefName?: string;
              author?: { login?: string };
              url?: string;
              state?: string;
            };
            if (
              typeof data.number === "number" &&
              typeof data.headRefName === "string"
            ) {
              resolve({
                number: data.number,
                title: data.title ?? "",
                branch: data.headRefName,
                author: data.author?.login ?? "",
                url: data.url ?? "",
                state: data.state ?? "OPEN",
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
      );
    });
  }
}
