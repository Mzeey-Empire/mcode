import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { rankPullRequests, ThreadPullRequestSchema, type ThreadPullRequest } from "@mcode/contracts/models/thread-pull-request";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { databaseWriteHandler } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { threadPullRequests, threads } from "../../../runtime/persistence/sqlite/schema.js";
import { threadPullRequestWriteOperations } from "./thread-pull-request-write-operations.js";

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
  mirrorPrimaryIntoLegacyColumnsForOlderBuilds(db, threadId, next[0]);
}

function mirrorPrimaryIntoLegacyColumnsForOlderBuilds(db: Database, threadId: string, primary: ThreadPullRequest | undefined): void {
  drizzle(db).update(threads).set({ prNumber: primary?.number ?? null, prStatus: primary?.state ?? null })
    .where(eq(threads.id, threadId)).run();
}

function clearPauseOnStateChange(db: Database, threadId: string, current: ThreadPullRequest[], next: ThreadPullRequest[]): void {
  const previousStates = new Map(current.map((pr) => [pr.number, pr.state]));
  const changed = current.length !== next.length || next.some((pr) => previousStates.get(pr.number) !== pr.state);
  if (!changed) return;
  db.query("UPDATE threads SET auto_complete_paused_at = NULL WHERE id = ?").run(threadId);
}

function readLinks(db: Database, threadId: string): ThreadPullRequest[] {
  const orm = drizzle(db);
  const thread = orm.select({ number: threads.prNumber }).from(threads).where(eq(threads.id, threadId)).get();
  if (!thread) throw new Error(`Thread ${threadId} not found`);
  const rows = orm.select({ number: threadPullRequests.number, state: threadPullRequests.state,
    title: threadPullRequests.title, url: threadPullRequests.url }).from(threadPullRequests)
    .where(eq(threadPullRequests.threadId, threadId)).all();
  if (rows.length > 0) return rows.map((row) => ThreadPullRequestSchema().parse(row));
  return thread.number === null ? [] : [{ number: thread.number, state: "unresolved", title: null, url: null }];
}

/** Merge links on the writable owner, joining an enclosing transaction when present. */
export function observeThreadPullRequests(db: Database, threadId: string, observations: readonly ThreadPullRequest[]): ThreadPullRequest[] | null {
  return db.transaction(() => {
    const current = readLinks(db, threadId);
    const next = mergeObservations(current, observations);
    if (JSON.stringify(rankPullRequests(current)) === JSON.stringify(next)) return null;
    writeLinks(db, threadId, next);
    clearPauseOnStateChange(db, threadId, current, next);
    return next;
  })();
}

/** Clear PR links inside a checkout transaction on the writable owner. */
export function forgetThreadPullRequests(db: Database, threadId: string): ThreadPullRequest[] | null {
  if (readLinks(db, threadId).length === 0) return null;
  writeLinks(db, threadId, []);
  db.query("UPDATE threads SET auto_complete_paused_at = NULL WHERE id = ?").run(threadId);
  return [];
}

/** Register PR operations on the application's writable database connection. */
export function buildThreadPullRequestWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const ops = threadPullRequestWriteOperations;
  return new Map([
    [ops.observe.name, databaseWriteHandler(ops.observe, ([threadId, prs]) => observeThreadPullRequests(db, threadId, prs))],
    [ops.forgetBranch.name, databaseWriteHandler(ops.forgetBranch, ([threadId]) => forgetThreadPullRequests(db, threadId))],
  ]);
}

/** Single owner of linked PR mutations, their committed pushes and watch sets. */
export class PullRequestLinkFunnel {
  private readonly listeners = new Set<(threadId: string) => void>();

  constructor(
    private readonly writer: ApplicationDatabaseWriter,
    private readonly publish: (threadId: string, prs: ThreadPullRequest[]) => void,
    private readonly setWatchSet: (threadId: string, numbers: number[]) => void,
  ) {}

  /** Observe committed link changes after their push and watch-set update. */
  onChanged(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Retain existing numbers and merged states while applying a new observation. */
  async observe(threadId: string, observations: readonly ThreadPullRequest[]): Promise<void> {
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
    for (const listener of this.listeners) listener(threadId);
  }
}
