import { logger } from "@mcode/shared";
import type { GithubService, PullRequestWatchSnapshot } from "../github/github-service.js";
import type { ChecksStatus } from "@mcode/contracts/github";
import type { Thread } from "@mcode/contracts/models/thread";

/** Internal tracking entry for one thread and linked PR. */
export interface WatchEntry {
  threadId: string;
  prNumber: number;
  branch: string;
  repoPath: string;
  cache: ChecksStatus | null;
}

type BroadcastFn = (channel: "thread.checksUpdated", data: { threadId: string; prNumber: number; checks: ChecksStatus }) => void;

/** Normalized PR observation detected while polling lifecycle and checks. */
export type PullRequestStateChange = Pick<PullRequestWatchSnapshot, "threadId" | "prNumber" | "state" | "title" | "url">;

type PullRequestStateChangeFn = (change: PullRequestStateChange) => void | Promise<void>;

const ACTIVE_INTERVAL_MS = 15_000;
const PASSIVE_INTERVAL_MS = 20_000;
const POST_PUSH_BUMP_DELAYS_MS = [3_000, 8_000, 20_000];

function watchKey(threadId: string, prNumber: number): string {
  return JSON.stringify([threadId, prNumber]);
}

/** Adaptive CI and lifecycle polling, independently keyed by thread and PR number. */
export class CiWatcherService {
  private active = new Map<string, WatchEntry>();
  private passive = new Map<string, WatchEntry>();
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private passiveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly bumpTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  private activeTicking = false;
  private passiveTicking = false;

  constructor(
    private readonly githubService: Pick<GithubService, "getCheckRuns" | "getPullRequestWatchSnapshots" | "cancelCheckRuns" | "cancelAllInFlight">,
    private readonly broadcast: BroadcastFn,
    private readonly onPullRequestStateChange?: PullRequestStateChangeFn,
  ) {}

  /** Add a PR without replacing other PRs linked to the same thread. */
  watch(threadId: string, prNumber: number, branch: string, repoPath: string, opts?: { skipInitialFetch?: boolean }): void {
    const previous = this.getEntry(threadId, prNumber);
    if (previous?.branch === branch && previous.repoPath === repoPath) return;
    if (previous) this.unwatch(threadId, prNumber);
    const entry: WatchEntry = { threadId, prNumber, branch, repoPath, cache: null };
    this.passive.set(watchKey(threadId, prNumber), entry);
    this.startPassiveTimer();
    if (opts?.skipInitialFetch) return;
    void this.fetchInitialChecks(entry);
  }

  private async fetchInitialChecks(entry: WatchEntry): Promise<void> {
    try {
      const checks = await this.githubService.getCheckRuns(entry.branch, entry.repoPath);
      if (this.getEntry(entry.threadId, entry.prNumber) === entry) this.refresh(entry.threadId, entry.prNumber, checks);
    } catch (error) {
      logger.debug("CiWatcher initial fetch failed", { threadId: entry.threadId, error: String(error) });
    }
  }

  /** Replace the open/draft watch set while retaining unchanged entries and their caches. */
  setWatchSet(threadId: string, numbers: readonly number[], branch: string, repoPath: string): void {
    const desired = new Set(numbers);
    for (const entry of this.entriesForThread(threadId)) {
      if (!desired.has(entry.prNumber)) this.unwatch(threadId, entry.prNumber);
    }
    for (const number of numbers) this.watch(threadId, number, branch, repoPath);
  }

  /** Remove one PR, or every PR when tearing down a thread. */
  unwatch(threadId: string, prNumber?: number): void {
    const entries = prNumber === undefined ? this.entriesForThread(threadId) : [this.getEntry(threadId, prNumber)];
    for (const entry of entries) {
      if (!entry) continue;
      const key = watchKey(entry.threadId, entry.prNumber);
      this.active.delete(key);
      this.passive.delete(key);
    }
    if (!this.isWatching(threadId)) this.clearBumpTimers(threadId);
    if (this.active.size === 0) this.stopActiveTimer();
    if (this.passive.size === 0) this.stopPassiveTimer();
  }

  /** Remove all thread entries and cancel GitHub processes holding its checkout. */
  async teardownThread(threadId: string): Promise<void> {
    const entries = this.entriesForThread(threadId);
    this.unwatch(threadId);
    const paths = new Map(entries.map((entry) => [JSON.stringify([entry.branch, entry.repoPath]), entry]));
    await Promise.all([...paths.values()].map((entry) => this.githubService.cancelCheckRuns(entry.branch, entry.repoPath)));
  }

  /** Whether one PR, or any PR belonging to a thread, is watched. */
  isWatching(threadId: string, prNumber?: number): boolean {
    return prNumber === undefined ? this.entriesForThread(threadId).length > 0 : this.getEntry(threadId, prNumber) !== null;
  }

  /** Read the independent cache for a specific linked PR. */
  getEntry(threadId: string, prNumber: number): WatchEntry | null {
    const key = watchKey(threadId, prNumber);
    return this.active.get(key) ?? this.passive.get(key) ?? null;
  }

  /** Return a PR's cached checks only while its fetch time is fresh. */
  getFreshCache(threadId: string, prNumber: number, maxAgeMs: number): ChecksStatus | null {
    const entry = this.getEntry(threadId, prNumber);
    if (!entry?.cache || Date.now() - entry.cache.fetchedAt > maxAgeMs) return null;
    return entry.cache;
  }

  /** Refresh one PR's checks and adapt its polling cadence. */
  refresh(threadId: string, prNumber: number, checks: ChecksStatus): void {
    const entry = this.getEntry(threadId, prNumber);
    if (!entry) return;
    const changed = this.hasChanged(entry.cache, checks);
    entry.cache = checks;
    if (changed) this.broadcast("thread.checksUpdated", { threadId, prNumber, checks });
    this.setCadence(entry, checks.aggregate === "pending");
  }

  private setCadence(entry: WatchEntry, pending: boolean): void {
    const key = watchKey(entry.threadId, entry.prNumber);
    if (pending) {
      this.passive.delete(key);
      this.active.set(key, entry);
      this.startActiveTimer();
      if (this.passive.size === 0) this.stopPassiveTimer();
    } else {
      this.active.delete(key);
      this.passive.set(key, entry);
      this.startPassiveTimer();
      if (this.active.size === 0) this.stopActiveTimer();
    }
  }

  /** Refresh every PR on a thread after an explicit push. */
  async bump(threadId: string): Promise<void> {
    await Promise.all(this.entriesForThread(threadId).map((entry) => this.fetchInitialChecks(entry)));
  }

  /** Poll on the existing Actions registration curve after a push. */
  scheduleBumpAfterPush(threadId: string): void {
    if (!this.isWatching(threadId)) return;
    this.clearBumpTimers(threadId);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    this.bumpTimers.set(threadId, timers);
    for (const delay of POST_PUSH_BUMP_DELAYS_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (timers.size === 0) this.bumpTimers.delete(threadId);
        void this.bump(threadId);
      }, delay);
      timer.unref?.();
      timers.add(timer);
    }
  }

  /** Find watched threads on a pushed branch, returning each thread once. */
  findByWorkspaceBranch(
    threadLookup: (threadId: string) => { branch: string; workspace_id: string } | null,
    workspaceId: string,
    branch: string,
  ): string[] {
    const ids = new Set([...this.active.values(), ...this.passive.values()].map((entry) => entry.threadId));
    return [...ids].filter((id) => {
      const thread = threadLookup(id);
      return thread?.workspace_id === workspaceId && thread.branch === branch;
    });
  }

  /** Seed every observed open or draft PR without relying on the legacy primary link. */
  async seed(
    threads: Array<Pick<Thread, "id" | "pull_requests" | "branch">>,
    workspacePaths: Map<string, string>,
    getWorkspaceId: (threadId: string) => string | null,
  ): Promise<void> {
    const entries: WatchEntry[] = [];
    for (const thread of threads) {
      const workspaceId = getWorkspaceId(thread.id);
      const repoPath = workspaceId ? workspacePaths.get(workspaceId) : undefined;
      if (!repoPath) continue;
      this.seedThread(thread, repoPath, entries);
    }
    await this.poll(entries);
    logger.info(`CiWatcher seeded: ${this.active.size} active, ${this.passive.size} passive`);
  }

  private seedThread(thread: Pick<Thread, "id" | "pull_requests" | "branch">, repoPath: string, entries: WatchEntry[]): void {
    for (const pr of thread.pull_requests) {
      if (pr.state !== "open" && pr.state !== "draft") continue;
      this.watch(thread.id, pr.number, thread.branch, repoPath, { skipInitialFetch: true });
      const entry = this.getEntry(thread.id, pr.number);
      if (entry) entries.push(entry);
    }
  }

  /** Cancel timers and in-flight work on server shutdown. */
  async dispose(): Promise<void> {
    for (const threadId of this.bumpTimers.keys()) this.clearBumpTimers(threadId);
    this.stopActiveTimer();
    this.stopPassiveTimer();
    this.active.clear();
    this.passive.clear();
    await this.githubService.cancelAllInFlight();
  }

  private entriesForThread(threadId: string): WatchEntry[] {
    return [...this.active.values(), ...this.passive.values()].filter((entry) => entry.threadId === threadId);
  }

  private startActiveTimer(): void {
    if (this.activeTimer) return;
    this.activeTimer = setInterval(async () => {
      if (this.activeTicking) return;
      this.activeTicking = true;
      try { await this.poll([...this.active.values()]); } finally { this.activeTicking = false; }
    }, ACTIVE_INTERVAL_MS);
  }

  private stopActiveTimer(): void {
    if (this.activeTimer) clearInterval(this.activeTimer);
    this.activeTimer = null;
  }

  private startPassiveTimer(): void {
    if (this.passiveTimer) return;
    this.passiveTimer = setInterval(async () => {
      if (this.passiveTicking) return;
      this.passiveTicking = true;
      try { await this.poll([...this.passive.values()]); } finally { this.passiveTicking = false; }
    }, PASSIVE_INTERVAL_MS);
  }

  private stopPassiveTimer(): void {
    if (this.passiveTimer) clearInterval(this.passiveTimer);
    this.passiveTimer = null;
  }

  private clearBumpTimers(threadId: string): void {
    const timers = this.bumpTimers.get(threadId);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    this.bumpTimers.delete(threadId);
  }

  private hasChanged(cached: ChecksStatus | null, next: ChecksStatus): boolean {
    return cached == null
      || cached.aggregate !== next.aggregate
      || cached.runs.length !== next.runs.length
      || cached.runs.some((run, index) => {
        const updated = next.runs[index];
        return updated && (run.status !== updated.status || run.conclusion !== updated.conclusion);
      });
  }

  private async poll(entries: WatchEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      const snapshots = await this.githubService.getPullRequestWatchSnapshots(entries.map((entry) => ({
        threadId: entry.threadId, prNumber: entry.prNumber, repoPath: entry.repoPath,
      })));
      const requested = new Map(entries.map((entry) => [watchKey(entry.threadId, entry.prNumber), entry]));
      for (const snapshot of snapshots) {
        const entry = requested.get(watchKey(snapshot.threadId, snapshot.prNumber));
        if (entry && this.getEntry(entry.threadId, entry.prNumber) === entry) await this.applyWatchSnapshot(entry, snapshot);
      }
    } catch (error) {
      logger.debug("CiWatcher batch tick failed", { error: String(error) });
    }
  }

  private async applyWatchSnapshot(entry: WatchEntry, snapshot: PullRequestWatchSnapshot): Promise<void> {
    await this.onPullRequestStateChange?.({
      threadId: entry.threadId, prNumber: entry.prNumber, state: snapshot.state, title: snapshot.title, url: snapshot.url,
    });
    if (this.getEntry(entry.threadId, entry.prNumber) !== entry) return;
    if (snapshot.state === "closed" || snapshot.state === "merged") {
      this.unwatch(entry.threadId, entry.prNumber);
      return;
    }
    this.refresh(entry.threadId, entry.prNumber, snapshot.checks);
  }
}
