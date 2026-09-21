/**
 * Production git executor.
 * Wraps promisified execFile with per-repo serialisation for mutating
 * commands, a configurable default timeout, and a transparent result cache
 * for cheap rev-parse calls. Read-only commands bypass the queue.
 */

import { injectable } from "tsyringe";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import type { GitExecutor, GitExecOptions, GitExecResult } from "./types.js";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Noop used to suppress unhandled-rejection warnings on queue chains. */
const noop = () => {};

/** Git subcommands that never mutate repository state in any form. */
const READ_ONLY_COMMANDS = new Set([
  "blame",
  "cat-file",
  "check-ignore",
  "count-objects",
  "describe",
  "diff",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
]);

/** Global git options that consume the following argument as their value. */
const VALUE_TAKING_GLOBAL_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path"]);

/** Flags that turn `git branch` into a mutation rather than a listing. */
const BRANCH_MUTATION_FLAGS = new Set([
  "-d", "-D", "--delete",
  "-m", "-M", "--move",
  "-c", "-C", "--copy",
  "-f", "--force",
  "-u", "--set-upstream-to", "--unset-upstream",
  "--edit-description",
  "--track", "--no-track",
]);

/** `git config` flags that read values instead of writing them. */
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]);

/** Read-only arg shapes for subcommands that can also mutate. */
const MIXED_COMMAND_READS: Record<string, (rest: readonly string[]) => boolean> = {
  worktree: (rest) => rest[0] === "list",
  branch: (rest) => rest.every(
    (arg) => arg.startsWith("-") && !BRANCH_MUTATION_FLAGS.has(arg.split("=", 1)[0]!),
  ),
  remote: (rest) => rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url" || rest[0] === "show",
  config: (rest) => rest.some((arg) => CONFIG_READ_FLAGS.has(arg)),
  "symbolic-ref": (rest) => rest.some((arg) => arg === "--short" || arg === "-q" || arg === "--quiet")
    && rest.filter((arg) => !arg.startsWith("-")).length <= 1,
};

/**
 * Classify commands that cannot mutate repository state. Only these bypass
 * the per-directory serialisation queue; every other command keeps the queue
 * so index-, ref-, and worktree-mutating calls cannot race.
 */
function isReadOnlyGitCommand(args: readonly string[]): boolean {
  const index = gitSubcommandIndex(args);
  if (index < 0) return false;
  const command = args[index]!;
  const mixedRead = MIXED_COMMAND_READS[command];
  if (mixedRead) return mixedRead(args.slice(index + 1));
  return READ_ONLY_COMMANDS.has(command);
}

/** Find the subcommand position after any leading global options like `-C`. */
function gitSubcommandIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (VALUE_TAKING_GLOBAL_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/**
 * Production implementation of {@link GitExecutor}.
 *
 * Features:
 * - Serialises concurrent mutating git calls per effective working directory
 *   so that index-mutating operations (worktree add/remove, checkout) do not
 *   race. Read-only commands run unqueued so a slow mutation cannot stall
 *   watchers and other queries on the same repository.
 * - Transparent LRU-style cache for `rev-parse --git-dir` and
 *   `rev-parse --show-toplevel` results keyed by cwd.
 * - Default timeout of 10 s, overridable per call.
 */
@injectable()
export class RealGitExecutor implements GitExecutor {
  /** Default timeout in milliseconds for all git invocations. */
  static readonly DEFAULT_TIMEOUT = 10_000;

  /** Per-directory promise queues (key = effective cwd). */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Cache for `rev-parse --git-dir` and `rev-parse --show-toplevel` results.
   * Key format: `"git-dir:<cwd>"` or `"show-toplevel:<cwd>"`.
   */
  private readonly revParseCache = new Map<string, GitExecResult>();

  /**
   * Run `git` with the given arguments. Mutating commands are serialised per
   * effective cwd; read-only commands run immediately.
   * Results of `rev-parse --git-dir` and `rev-parse --show-toplevel` are
   * cached transparently so repeated probe calls are free.
   */
  async exec(args: string[], opts: GitExecOptions = {}): Promise<GitExecResult> {
    const cacheKey = this.getCacheKey(args);
    const readOnly = isReadOnlyGitCommand(args);

    const invoke = async (): Promise<GitExecResult> => {
      // Re-check the cache inside the queue turn in case a concurrent queued
      // operation already populated it while we were waiting.
      const cachedNow = cacheKey ? this.revParseCache.get(cacheKey) : undefined;
      if (cachedNow) return cachedNow;

      const result = await this.runGit(args, opts);
      if (cacheKey) {
        this.revParseCache.set(cacheKey, result);
      } else if (!readOnly) {
        this.invalidateRevParseCacheForCwd(this.getEffectiveCwd(args, opts));
      }
      return result;
    };

    if (readOnly) return invoke();
    return this.enqueue(this.getQueueKey(args, opts), invoke);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Enqueue an async operation behind any previously queued operation for the
   * same key. Each operation runs regardless of whether the previous one
   * succeeded or failed, preventing a single error from stalling the queue.
   */
  private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.queues.get(key) ?? Promise.resolve()) as Promise<void>;
    // Run fn after prev settles (success or failure).
    const next = prev.then(fn, fn);
    // Store a void sentinel so map values are homogeneous and results don't
    // accumulate in memory.
    const sentinel = next.then(noop, noop);
    this.queues.set(key, sentinel);
    return next;
  }

  /** Invoke git, returning stdout/stderr as UTF-8 strings. */
  private async runGit(
    args: string[],
    opts: GitExecOptions,
  ): Promise<GitExecResult> {
    if (opts.onStdout || opts.onStderr) return await this.runObservedGit(args, opts);
    const timeout = opts.timeout ?? RealGitExecutor.DEFAULT_TIMEOUT;
    const result = await execFile("git", args, {
      timeout,
      windowsHide: true,
      encoding: "utf8",
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
    };
  }

  /** Run Git with streamed output while preserving the buffered result and error contract. */
  private async runObservedGit(args: string[], opts: GitExecOptions): Promise<GitExecResult> {
    const timeout = opts.timeout ?? RealGitExecutor.DEFAULT_TIMEOUT;
    return await new Promise<GitExecResult>((resolve, reject) => {
      const child = NodeChildProcess.spawn("git", args, {
        windowsHide: true,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeout);
      const finish = (result: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        opts.onStdout?.(text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        opts.onStderr?.(text);
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code, signal) => finish(() => {
        if (timedOut) {
          reject(Object.assign(new Error(`Git command timed out after ${timeout} ms`), {
            code: null,
            signal,
            stdout,
            stderr,
            killed: true,
          }));
          return;
        }
        if (code !== 0) {
          reject(Object.assign(new Error(`Git exited with code ${code ?? "unknown"}`), {
            code,
            signal,
            stdout,
            stderr,
          }));
          return;
        }
        resolve({ stdout, stderr });
      }));
    });
  }

  /**
   * Extract the effective working directory from a `-C <path>` arg or
   * `opts.cwd`, used as the serialisation queue key.
   */
  private getQueueKey(args: string[], opts: GitExecOptions): string {
    return this.getEffectiveCwd(args, opts);
  }

  /** Drop cached rev-parse probes for a checkout after mutating git commands. */
  private invalidateRevParseCacheForCwd(cwd: string): void {
    if (cwd === "__global__") return;
    this.revParseCache.delete(`git-dir:${cwd}`);
    this.revParseCache.delete(`show-toplevel:${cwd}`);
  }

  /** Extract the effective working directory from `-C <path>` or `opts.cwd`. */
  private getEffectiveCwd(args: string[], opts: GitExecOptions): string {
    const cIdx = args.indexOf("-C");
    if (cIdx !== -1 && cIdx + 1 < args.length) return args[cIdx + 1]!;
    return opts.cwd ?? "__global__";
  }

  /**
   * Return a deterministic cache key when the command is a cheap read-only
   * rev-parse probe that produces stable output for a given repo checkout.
   * Returns null for all other commands.
   */
  private getCacheKey(args: string[]): string | null {
    if (!args.includes("rev-parse")) return null;
    const cIdx = args.indexOf("-C");
    if (cIdx === -1 || cIdx + 1 >= args.length) return null;
    const cwd = args[cIdx + 1]!;
    if (args.includes("--git-dir")) return `git-dir:${cwd}`;
    if (args.includes("--show-toplevel")) return `show-toplevel:${cwd}`;
    return null;
  }
}
