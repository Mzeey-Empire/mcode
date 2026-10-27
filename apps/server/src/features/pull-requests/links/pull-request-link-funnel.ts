import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { rankPullRequests, type ThreadPullRequest } from "@mcode/contracts/models/thread-pull-request";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { databaseWriteHandler } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { threadPullRequests, threads } from "../../../runtime/persistence/sqlite/schema.js";
import { ThreadStore } from "../../thread-control/persistence/thread-store.js";
import { threadPullRequestWriteOperations } from "./thread-pull-request-write-operations.js";

/** Source of a PR observation, for callers' diagnostics. */
export type ObservationSource = "created" | "turn-settled" | "watcher" | "sync" | "review-link";

function mergeObservations(current: ThreadPullRequest[], observations: readonly ThreadPullRequest[]): ThreadPullRequest[] {
  const byNumber = new Map(current.map((pr) => [pr.number, pr]));
  for (const observation of observations) {
    const previous = byNumber.get(observation.number);
    byNumber.set(observation.number, {
      ...observation,
      state: previous?.state === "merged" ? "merged" : observation.state,
      title: observation.title ?? previous?.title ?? null,
      url: observation.url ?? previous?.url ?? null,
    });
  }
  return rankPullRequests([...byNumber.values()]);
}

function writeLinks(db: Database, threadId: string, next: ThreadPullRequest[]): void {
  const orm = drizzle(db);
  orm.delete(threadPullRequests).where(eq(threadPullRequests.threadId, threadId)).run();
  if (next.length > 0) {
    const observedAt = new Date().toISOString();
    orm.insert(threadPullRequests).values(next.map((pr) => ({ ...pr, threadId, observedAt }))).run();
  }
  const primary = next[0];
  // Older builds share this database and still read the single-PR columns.
  orm.update(threads).set({ prNumber: primary?.number ?? null, prStatus: primary?.state ?? null })
    .where(eq(threads.id, threadId)).run();
}

/** Merge links on the writable owner, joining an enclosing transaction when present. */
export function observeThreadPullRequests(db: Database, threadId: string, observations: readonly ThreadPullRequest[]): ThreadPullRequest[] | null {
  return db.transaction(() => {
    const thread = new ThreadStore(db).findById(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    const next = mergeObservations(thread.pull_requests, observations);
    if (JSON.stringify(rankPullRequests(thread.pull_requests)) === JSON.stringify(next)) return null;
    writeLinks(db, threadId, next);
    return next;
  })();
}

function forgetBranch(db: Database, threadId: string): ThreadPullRequest[] | null {
  const thread = new ThreadStore(db).findById(threadId);
  if (!thread || thread.pull_requests.length === 0) return null;
  writeLinks(db, threadId, []);
  return [];
}

/** Register PR operations on the application's writable database connection. */
export function buildThreadPullRequestWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const ops = threadPullRequestWriteOperations;
  return new Map([
    [ops.observe.name, databaseWriteHandler(ops.observe, ([threadId, prs]) => observeThreadPullRequests(db, threadId, prs))],
    [ops.forgetBranch.name, databaseWriteHandler(ops.forgetBranch, ([threadId]) => forgetBranch(db, threadId))],
  ]);
}

/** Single owner of linked PR mutations, their committed pushes and watch sets. */
export class PullRequestLinkFunnel {
  constructor(
    private readonly writer: ApplicationDatabaseWriter,
    private readonly publish: (threadId: string, prs: ThreadPullRequest[]) => void,
    private readonly setWatchSet: (threadId: string, numbers: number[]) => void,
  ) {}

  /** Retain existing numbers and merged states while applying a new observation. */
  async observe(threadId: string, observations: readonly ThreadPullRequest[], _source: ObservationSource): Promise<void> {
    const changed = await this.writer.execute(threadPullRequestWriteOperations.observe, [threadId, [...observations]]);
    if (changed) this.publishCommitted(threadId, changed);
  }

  /** Clear links when the checkout moves to a different branch. */
  async forgetBranch(threadId: string): Promise<void> {
    const changed = await this.writer.execute(threadPullRequestWriteOperations.forgetBranch, [threadId]);
    if (changed) this.publishCommitted(threadId, changed);
  }

  /** Publish a link set returned by a committed compound write. */
  publishCommitted(threadId: string, prs: ThreadPullRequest[]): void {
    this.publish(threadId, prs);
    this.setWatchSet(threadId, prs.filter((pr) => pr.state === "open" || pr.state === "draft").map((pr) => pr.number));
  }
}
