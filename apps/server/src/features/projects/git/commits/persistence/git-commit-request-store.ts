/**
 * SQLite access for durable commit requests. Rows are parsed into the state union here, so
 * the rest of the server never reads loose nullable columns.
 */
import type { Database } from "bun:sqlite";
import { and, eq, lt, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { runChanges } from "../../../../../runtime/persistence/sqlite/drizzle-changes.js";
import { gitCommitRequests } from "../../../../../runtime/persistence/sqlite/schema.js";
import {
  CommitRequestRecordSchema,
  type CommitPushState,
  type CommitRequestRecord,
  type CommitSettlement,
  type FinishedCommitPush,
  type PreparedCommitRequestInput,
} from "../commit-request.js";

type GitCommitRequestRow = typeof gitCommitRequests.$inferSelect;
type SettledColumns = Pick<
  GitCommitRequestRow,
  "state" | "commitSha" | "rejection" | "pushDestination" | "pushState" | "pushFailure"
>;

const nowSql = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function rowState(row: GitCommitRequestRow): Record<string, unknown> {
  switch (row.state) {
    case "prepared":
      return { destination: parseJson(row.pushDestination) };
    case "committed":
      return {
        commitSha: row.commitSha,
        push: row.pushState === "skipped"
          ? { state: "skipped" }
          : { state: row.pushState, destination: parseJson(row.pushDestination), ...pushFailure(row) },
      };
    case "rejected":
      return { rejection: parseJson(row.rejection) };
    case "unknown":
      return unknownState(row);
    default:
      return {};
  }
}

function pushFailure(row: GitCommitRequestRow): Record<string, unknown> {
  return row.pushState === "failed" ? { failure: parseJson(row.pushFailure) } : {};
}

function unknownState(row: GitCommitRequestRow): Record<string, unknown> {
  // Unknown rows keep {head, detail} in the rejection column; the spec's table has no other slot for the head.
  const stored = parseJson(row.rejection);
  return typeof stored === "object" && stored !== null ? { ...stored } : {};
}

/** Parse one row into the state union; a row that does not fit throws instead of being guessed at. */
export function parseCommitRequestRow(row: GitCommitRequestRow): CommitRequestRecord {
  return CommitRequestRecordSchema.parse({
    requestId: row.requestId,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    repoPath: row.repoPath,
    inputsHash: row.inputsHash,
    originalHead: row.originalHead,
    branch: row.branch,
    preparedAt: row.preparedAt,
    updatedAt: row.updatedAt,
    state: row.state,
    ...rowState(row),
  });
}

function pushColumns(push: CommitPushState): Pick<SettledColumns, "pushDestination" | "pushState" | "pushFailure"> {
  if (push.state === "skipped") return { pushDestination: null, pushState: "skipped", pushFailure: null };
  return {
    pushDestination: JSON.stringify(push.destination),
    pushState: push.state,
    pushFailure: push.state === "failed" ? JSON.stringify(push.failure) : null,
  };
}

function settlementColumns(settlement: CommitSettlement): Partial<SettledColumns> {
  switch (settlement.state) {
    case "committed":
      return { state: "committed", commitSha: settlement.commitSha, rejection: null, ...pushColumns(settlement.push) };
    case "rejected":
      return { state: "rejected", rejection: JSON.stringify(settlement.rejection), pushState: "skipped" };
    case "unknown":
      return {
        state: "unknown",
        rejection: JSON.stringify({ head: settlement.head, detail: settlement.detail }),
        pushState: "skipped",
      };
  }
}

/** Synchronous storage for git_commit_requests. Writes run on the database writer. */
export class GitCommitRequestStore {
  private readonly db: BunSQLiteDatabase;

  constructor(database: Database) {
    this.db = drizzle(database);
  }

  /** Read one request by its client id. */
  findById(requestId: string): CommitRequestRecord | null {
    const row = this.db.select().from(gitCommitRequests).where(eq(gitCommitRequests.requestId, requestId)).get();
    return row ? parseCommitRequestRow(row) : null;
  }

  /** Every request no process has settled yet. */
  listPrepared(): CommitRequestRecord[] {
    return this.db.select().from(gitCommitRequests).where(eq(gitCommitRequests.state, "prepared")).all()
      .map(parseCommitRequestRow);
  }

  /** Insert a prepared request. A duplicate requestId fails instead of overwriting. */
  insertPrepared(input: PreparedCommitRequestInput): void {
    this.db.insert(gitCommitRequests).values({
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      repoPath: input.repoPath,
      inputsHash: input.inputsHash,
      originalHead: input.originalHead,
      branch: input.branch,
      state: "prepared",
      pushDestination: input.destination ? JSON.stringify(input.destination) : null,
      pushState: input.destination ? "pending" : "skipped",
      preparedAt: nowSql,
      updatedAt: nowSql,
    }).run();
  }

  /** Settle a prepared request. Returns false when it was no longer prepared. */
  settle(requestId: string, settlement: CommitSettlement): boolean {
    const changes = runChanges(this.db.update(gitCommitRequests)
      .set({ ...settlementColumns(settlement), updatedAt: nowSql })
      .where(and(eq(gitCommitRequests.requestId, requestId), eq(gitCommitRequests.state, "prepared"))));
    return changes.changes === 1;
  }

  /** Record a finished push on a committed request whose push was pending. */
  recordPush(requestId: string, push: FinishedCommitPush): boolean {
    const changes = runChanges(this.db.update(gitCommitRequests)
      .set({ ...pushColumns(push), updatedAt: nowSql })
      .where(and(
        eq(gitCommitRequests.requestId, requestId),
        eq(gitCommitRequests.state, "committed"),
        eq(gitCommitRequests.pushState, "pending"),
      )));
    return changes.changes === 1;
  }

  /** Delete requests prepared more than `maxAgeDays` ago. */
  deleteExpired(maxAgeDays: number): number {
    return runChanges(this.db.delete(gitCommitRequests).where(lt(
      gitCommitRequests.preparedAt,
      sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${`-${maxAgeDays}`} || ' days')`,
    ))).changes;
  }
}
