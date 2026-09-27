/**
 * Thread data access layer.
 * Provides CRUD and lifecycle operations for thread records in SQLite.
 */

import * as NodeCrypto from "node:crypto";
import { injectable, inject } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { DevinModeSchema, ReasoningLevelSchema } from "@mcode/contracts";
import type { DevinMode, Thread, RecentThread, ThreadMode, ThreadStatus, ReasoningLevel, InteractionMode, OrchestrationMode, PermissionMode, ContextWindowMode } from "@mcode/contracts";
import {
  canonicalAgentThreads,
  cleanupJobs,
  pullRequestReviewLinks,
  threads,
  workspaces,
} from "../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";

type ThreadRow = typeof threads.$inferSelect;

const canonicalChildVisibility = sql`NOT EXISTS (
  SELECT 1
  FROM ${canonicalAgentThreads} canonical_child
  WHERE canonical_child.id = ${threads.id}
    AND canonical_child.parent_thread_id IS NOT NULL
)`;

function independentThreadClause(alias: string): string {
  return `NOT EXISTS (
    SELECT 1
    FROM canonical_collaboration_actions delegation
    WHERE delegation.target_thread_id = ${alias}.id
      AND delegation.kind = 'delegate'
  )`;
}

const CANONICAL_CHILD_DELETE_BATCH_SIZE = 64;

/** Persisted delegation provenance attached to a destination thread. */
export interface ThreadDelegationLineageRecord {
  coordinatorThreadId: string | null;
  creatorTurnId: string | null;
  creatorToolCallId: string | null;
  creationKind: "thread_delegation" | null;
}

/** Normalizes legacy reasoning values and rejects corrupted persisted state at the DB boundary. */
function parseStoredReasoningLevel(value: string | null): ReasoningLevel | null {
  if (value === null) return null;
  const parsed = ReasoningLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const CLEANUP_STATES = new Set(["queued", "running", "retrying", "blocked"]);

function parseCleanupState(value: string | null): Thread["cleanup_state"] {
  return CLEANUP_STATES.has(value ?? "")
    ? value as NonNullable<Thread["cleanup_state"]>
    : null;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    ...rowToThreadIdentity(row),
    ...rowToThreadLifecycle(row),
    ...rowToThreadPreferences(row),
    ...rowToThreadProviderSettings(row),
  };
}

function rowToThreadIdentity(row: ThreadRow): Pick<Thread,
  "id" | "workspace_id" | "title" | "status" | "mode" | "worktree_path" | "branch"
  | "checkout_state" | "base_branch" | "worktree_managed" | "issue_number" | "pr_number"
  | "pr_status" | "sdk_session_id" | "model" | "provider" | "created_at" | "updated_at"
> {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    title: row.title,
    status: row.status as ThreadStatus,
    mode: row.mode as ThreadMode,
    worktree_path: row.worktreePath,
    branch: row.branch,
    checkout_state: row.checkoutState === "branchless" ? "branchless" : "named",
    base_branch: row.baseBranch ?? null,
    worktree_managed: row.worktreeManaged === 1,
    issue_number: row.issueNumber,
    pr_number: row.prNumber,
    pr_status: row.prStatus,
    sdk_session_id: row.sdkSessionId,
    model: row.model ?? null,
    provider: row.provider,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function rowToThreadLifecycle(row: ThreadRow): Pick<Thread,
  "deleted_at" | "user_completed_at" | "scheduled_deletion_at" | "cleanup_state" | "cleanup_reason"
  | "last_context_tokens" | "context_window" | "parent_thread_id" | "forked_from_message_id"
  | "last_compact_summary" | "has_file_changes"
> {
  return {
    deleted_at: row.deletedAt,
    user_completed_at: row.userCompletedAt,
    scheduled_deletion_at: row.scheduledDeletionAt,
    cleanup_state: parseCleanupState(row.cleanupState),
    cleanup_reason: row.cleanupReason,
    last_context_tokens: row.lastContextTokens ?? null,
    context_window: row.contextWindow ?? null,
    parent_thread_id: row.parentThreadId,
    forked_from_message_id: row.forkedFromMessageId,
    last_compact_summary: row.lastCompactSummary,
    has_file_changes: row.hasFileChanges === 1,
  };
}

function rowToThreadPreferences(row: ThreadRow): Pick<Thread,
  "reasoning_level" | "interaction_mode" | "orchestration_mode" | "permission_mode" | "context_window_mode"
> {
  return {
    reasoning_level: parseStoredReasoningLevel(row.reasoningLevel),
    interaction_mode: (row.interactionMode ?? null) as InteractionMode | null,
    orchestration_mode: (row.orchestrationMode ?? null) as OrchestrationMode | null,
    permission_mode: (row.permissionMode ?? null) as PermissionMode | null,
    context_window_mode:
      (row.contextWindowMode ?? null) as ContextWindowMode | null,
  };
}

function rowToThreadProviderSettings(row: ThreadRow): Pick<Thread,
  "thinking" | "codex_fast_mode" | "copilot_agent" | "devin_mode" | "default_open_in_app"
> {
  return {
    thinking: row.thinking == null ? null : row.thinking === 1,
    codex_fast_mode:
      row.codexFastMode == null ? null : row.codexFastMode === 1,
    copilot_agent: (row.copilotAgent ?? null) as string | null,
    devin_mode: parseStoredDevinMode(row.devinMode),
    default_open_in_app: row.defaultOpenInApp ?? null,
  };
}

/** Rejects corrupted persisted Devin modes at the DB boundary. */
function parseStoredDevinMode(value: string | null): DevinMode | null {
  if (value === null) return null;
  const parsed = DevinModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type ThreadCreateLineage = {
  parentThreadId: string;
  forkedFromMessageId: string;
};

type ThreadCreateRecordInput = {
  id: string;
  workspaceId: string;
  title: string;
  mode: ThreadMode;
  branch: string;
  worktreeManaged: boolean;
  provider: string;
  lineage: ThreadCreateLineage | undefined;
  checkoutState: "named" | "branchless";
  baseBranch: string | null;
  now: string;
};

function createThreadRecord(input: ThreadCreateRecordInput): Thread {
  return {
    id: input.id,
    workspace_id: input.workspaceId,
    title: input.title,
    status: "active",
    mode: input.mode,
    worktree_path: null,
    branch: input.branch,
    checkout_state: input.checkoutState,
    base_branch: input.baseBranch,
    worktree_managed: input.worktreeManaged,
    issue_number: null,
    pr_number: null,
    pr_status: null,
    sdk_session_id: null,
    model: null,
    provider: input.provider,
    created_at: input.now,
    updated_at: input.now,
    deleted_at: null,
    user_completed_at: null,
    scheduled_deletion_at: null,
    cleanup_state: null,
    cleanup_reason: null,
    last_context_tokens: null,
    context_window: null,
    reasoning_level: null,
    interaction_mode: null,
    orchestration_mode: null,
    permission_mode: null,
    context_window_mode: null,
    thinking: null,
    codex_fast_mode: null,
    copilot_agent: null,
    devin_mode: null,
    default_open_in_app: null,
    parent_thread_id: input.lineage?.parentThreadId ?? null,
    forked_from_message_id: input.lineage?.forkedFromMessageId ?? null,
    last_compact_summary: null,
    has_file_changes: false,
  };
}

type ThreadSearchOptions = {
  query: string;
  filters?: { status?: string[]; provider?: string[] };
  workspaceIds?: string[];
  excludeThreadId?: string;
  createdByIntegrationId?: string;
  sort?: { field: "updated_at" | "created_at" | "title"; direction: "asc" | "desc" };
  limit?: number;
};

function searchQueryCondition(query: string): SQL | undefined {
  if (!query) return undefined;
  const escapedQuery = query.replace(/[%_]/g, "\\$&");
  const pattern = `%${escapedQuery}%`;
  return or(
    sql`${threads.title} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`,
    sql`${workspaces.name} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`,
    sql`${workspaces.path} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`,
    sql`${threads.provider} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`,
    sql`${threads.branch} LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`,
    sql`COALESCE(${threads.worktreePath}, '') LIKE ${pattern} ESCAPE '\\' COLLATE NOCASE`,
  );
}

const SEARCH_SORT_COLUMNS = {
  updated_at: threads.updatedAt,
  created_at: threads.createdAt,
  title: threads.title,
} as const;

function validatedSearchSort(sort: ThreadSearchOptions["sort"]): { field: keyof typeof SEARCH_SORT_COLUMNS; direction: "asc" | "desc" } {
  const field = sort?.field ?? "updated_at";
  const direction = sort?.direction ?? "desc";
  if (!SEARCH_SORT_COLUMNS[field] || (direction !== "asc" && direction !== "desc")) {
    throw new Error(`Invalid sort parameters: ${field} ${direction}`);
  }
  return { field, direction };
}

function resolveSearchOrder(sort: ThreadSearchOptions["sort"]): SQL[] {
  const { field, direction } = validatedSearchSort(sort);
  const order = direction === "asc" ? asc(SEARCH_SORT_COLUMNS[field]) : desc(SEARCH_SORT_COLUMNS[field]);
  return field === "updated_at" && direction === "desc" ? [order, asc(threads.id)] : [order];
}

function searchScopeConditions(opts: ThreadSearchOptions): (SQL | undefined)[] {
  return [
    opts.workspaceIds?.length ? inArray(threads.workspaceId, opts.workspaceIds) : undefined,
    opts.excludeThreadId ? ne(threads.id, opts.excludeThreadId) : undefined,
    opts.createdByIntegrationId === undefined ? undefined : eq(threads.createdByIntegrationId, opts.createdByIntegrationId),
  ];
}

function searchConditions(opts: ThreadSearchOptions): (SQL | undefined)[] {
  const filters = opts.filters ?? {};
  return [
    isNull(threads.deletedAt),
    isNull(workspaces.deletedAt),
    canonicalChildVisibility,
    searchQueryCondition(opts.query),
    filters.status?.length ? inArray(threads.status, filters.status) : undefined,
    filters.provider?.length ? inArray(threads.provider, filters.provider) : undefined,
    ...searchScopeConditions(opts),
  ];
}

function createSearchResult(
  rows: Array<ThreadRow & { wId: string; wName: string; wPath: string }>,
): { threads: Thread[]; workspaces: { id: string; name: string; path: string }[] } {
  const workspaceMap = new Map<string, { id: string; name: string; path: string }>();
  for (const row of rows) {
    if (!workspaceMap.has(row.wId)) {
      workspaceMap.set(row.wId, { id: row.wId, name: row.wName, path: row.wPath });
    }
  }
  return { threads: rows.map(rowToThread), workspaces: [...workspaceMap.values()] };
}

function resolveNextBaseBranch(
  current: Thread,
  checkoutState: "named" | "branchless",
  baseBranch: string | null,
): string | null {
  return checkoutState === "named" && current.checkout_state === "branchless" && baseBranch === null
    ? current.base_branch
    : baseBranch;
}

function serializeBooleanOverride(value: boolean | null): number | null {
  return value == null ? null : value ? 1 : 0;
}

type ThreadSettings = {
  model?: string;
  provider?: string;
  reasoning_level?: string;
  interaction_mode?: string;
  orchestration_mode?: string;
  permission_mode?: string;
  context_window_mode?: ContextWindowMode | null;
  thinking?: boolean | null;
  codex_fast_mode?: boolean | null;
  copilot_agent?: string | null;
  devin_mode?: string | null;
  default_open_in_app?: string | null;
};

const TEXT_SETTING_COLUMNS = [
  ["model", "model"],
  ["provider", "provider"],
  ["reasoning_level", "reasoningLevel"],
  ["interaction_mode", "interactionMode"],
  ["orchestration_mode", "orchestrationMode"],
  ["permission_mode", "permissionMode"],
  ["context_window_mode", "contextWindowMode"],
  ["copilot_agent", "copilotAgent"],
  ["devin_mode", "devinMode"],
  ["default_open_in_app", "defaultOpenInApp"],
] as const satisfies readonly (readonly [keyof ThreadSettings, keyof typeof threads.$inferInsert])[];

const BOOLEAN_SETTING_COLUMNS = [
  ["thinking", "thinking"],
  ["codex_fast_mode", "codexFastMode"],
] as const satisfies readonly (readonly [keyof ThreadSettings, keyof typeof threads.$inferInsert])[];

function buildSettingsSet(settings: ThreadSettings): Partial<typeof threads.$inferInsert> {
  const set: Record<string, unknown> = {};
  for (const [key, column] of TEXT_SETTING_COLUMNS) {
    const value = settings[key];
    if (value !== undefined) set[column] = value;
  }
  for (const [key, column] of BOOLEAN_SETTING_COLUMNS) {
    const value = settings[key];
    if (value !== undefined) set[column] = serializeBooleanOverride(value as boolean | null);
  }
  return set as Partial<typeof threads.$inferInsert>;
}

/** Maximum active sibling paths considered during one worktree ownership decision. */
export const MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS = 512;

/** Bounded active sibling paths used for canonical filesystem identity checks. */
export interface ActiveWorktreePathSet {
  paths: string[];
  truncated: boolean;
}

/** Completion timestamps used to calculate retention deadlines. */
export interface CompletedThreadRetentionRecord {
  id: string;
  userCompletedAt: string;
  scheduledDeletionAt: string | null;
}

/** Compare-and-set update for one completed thread's deletion deadline. */
export interface CompletedThreadDeadlineUpdate extends CompletedThreadRetentionRecord {
  nextScheduledDeletionAt: string | null;
}

/** Repository for thread lifecycle operations against SQLite. */
@injectable()
export class ThreadRepo {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /** Create a new thread and return the fully-populated record. */
  create(
    workspaceId: string,
    title: string,
    mode: ThreadMode,
    branch: string,
    worktreeManaged = true,
    provider = "claude",
    lineage?: {
      parentThreadId: string;
      forkedFromMessageId: string;
    },
    checkoutState: "named" | "branchless" = "named",
    baseBranch: string | null = null,
  ): Thread {
    const id = NodeCrypto.randomUUID();
    const now = new Date().toISOString();
    const managedInt = worktreeManaged ? 1 : 0;

    this.orm.insert(threads).values({
      id,
      workspaceId,
      title,
      status: "active",
      mode,
      branch,
      checkoutState,
      baseBranch,
      worktreeManaged: managedInt,
      provider,
      parentThreadId: lineage?.parentThreadId ?? null,
      forkedFromMessageId: lineage?.forkedFromMessageId ?? null,
      createdAt: now,
      updatedAt: now,
    }).run();

    return createThreadRecord({
      id,
      workspaceId,
      title,
      mode,
      branch,
      worktreeManaged,
      provider,
      lineage,
      checkoutState,
      baseBranch,
      now,
    });
  }

  /** Find a thread by its primary key, optionally constrained to one external owner. */
  findById(id: string, options: { createdByIntegrationId?: string } = {}): Thread | null {
    const row = this.orm
      .select()
      .from(threads)
      .where(and(
        eq(threads.id, id),
        options.createdByIntegrationId === undefined
          ? undefined
          : eq(threads.createdByIntegrationId, options.createdByIntegrationId),
      ))
      .get();

    return row ? rowToThread(row) : null;
  }

  /** List non-deleted threads for a workspace, most recent first. */
  listByWorkspace(workspaceId: string, limit = 100): Thread[] {
    const clampedLimit = Math.max(1, Math.min(1000, limit));

    const rows = this.orm
      .select()
      .from(threads)
      .where(and(
        eq(threads.workspaceId, workspaceId),
        isNull(threads.deletedAt),
        canonicalChildVisibility,
      ))
      .orderBy(desc(threads.createdAt))
      .limit(clampedLimit)
      .all();

    return rows.map(rowToThread);
  }

  /**
   * List the most recently active non-deleted threads across all workspaces,
   * joined with the parent workspace's name + path. Used by the landing's
   * "Recent threads" section to surface continuation candidates regardless of
   * which workspace is currently active.
   *
   * Sorted by `updated_at` (last activity), not `created_at`, so a long-lived
   * thread with recent traffic outranks a freshly-created idle one.
   */
  listRecent(limit = 12): RecentThread[] {
    const clampedLimit = Math.max(1, Math.min(50, limit));

    const rows = this.orm
      .select({
        ...getTableColumns(threads),
        workspaceName: workspaces.name,
        workspacePath: workspaces.path,
      })
      .from(threads)
      .innerJoin(workspaces, eq(workspaces.id, threads.workspaceId))
      .where(and(
        isNull(threads.deletedAt),
        isNull(threads.userCompletedAt),
        canonicalChildVisibility,
      ))
      .orderBy(desc(threads.updatedAt))
      .limit(clampedLimit)
      .all();

    return rows.map((row) => ({
      ...rowToThread(row),
      workspace_name: row.workspaceName,
      workspace_path: row.workspacePath,
    }));
  }

  /** Search non-deleted threads across title, project, provider, and checkout metadata. */
  search(opts: ThreadSearchOptions): { threads: Thread[]; workspaces: { id: string; name: string; path: string }[] } {
    const clampedLimit = Math.max(1, Math.min(200, opts.limit ?? 100));

    const rows = this.orm
      .select({
        ...getTableColumns(threads),
        wId: workspaces.id,
        wName: workspaces.name,
        wPath: workspaces.path,
      })
      .from(threads)
      .innerJoin(workspaces, eq(workspaces.id, threads.workspaceId))
      .where(and(...searchConditions(opts)))
      .orderBy(...resolveSearchOrder(opts.sort))
      .limit(clampedLimit)
      .all();

    return createSearchResult(rows);
  }

  /** Update a thread's lifecycle status. Returns true if a row was changed. */
  updateStatus(id: string, status: ThreadStatus): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ status, updatedAt: now })
      .where(eq(threads.id, id))
      );

    return result.changes > 0;
  }

  /** Persist the first user-completion timestamp and its deletion deadline. */
  complete(id: string, completedAt: string, scheduledDeletionAt: string | null): Thread | null {
    this.orm
      .update(threads)
      .set({
        userCompletedAt: sql`COALESCE(${threads.userCompletedAt}, ${completedAt})`,
        scheduledDeletionAt: sql`CASE
          WHEN ${threads.userCompletedAt} IS NULL THEN ${scheduledDeletionAt}
          ELSE ${threads.scheduledDeletionAt}
        END`,
        updatedAt: sql`CASE WHEN ${threads.userCompletedAt} IS NULL THEN ${completedAt} ELSE ${threads.updatedAt} END`,
      })
      .where(and(eq(threads.id, id), isNull(threads.deletedAt)))
      .run();
    return this.findById(id);
  }

  /** List one bounded page of completed threads for retention-policy calculation. */
  listCompletedRetentionRecords(
    afterId: string | null = null,
    limit = 100,
  ): CompletedThreadRetentionRecord[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.orm
      .select({
        id: threads.id,
        userCompletedAt: threads.userCompletedAt,
        scheduledDeletionAt: threads.scheduledDeletionAt,
      })
      .from(threads)
      .where(and(
        isNotNull(threads.userCompletedAt),
        isNull(threads.deletedAt),
        afterId === null ? undefined : gt(threads.id, afterId),
      ))
      .orderBy(asc(threads.id))
      .limit(boundedLimit)
      .all();
    return rows.map((row) => ({
      id: row.id,
      userCompletedAt: row.userCompletedAt!,
      scheduledDeletionAt: row.scheduledDeletionAt,
    }));
  }

  /** Apply deadline changes only while each completion record still matches its source state. */
  updateCompletedThreadDeadlines(updates: readonly CompletedThreadDeadlineUpdate[]): Thread[] {
    if (updates.length === 0) return [];
    const changedIds = this.orm.transaction((tx) => {
      const changed: string[] = [];
      for (const entry of updates) {
        const result = runChanges(tx.update(threads)
          .set({
            scheduledDeletionAt: entry.nextScheduledDeletionAt,
            cleanupState: sql`CASE WHEN ${threads.cleanupState} = 'blocked' THEN 'blocked' ELSE NULL END`,
            cleanupReason: sql`CASE WHEN ${threads.cleanupState} = 'blocked' THEN ${threads.cleanupReason} ELSE NULL END`,
          })
          .where(and(
            eq(threads.id, entry.id),
            eq(threads.userCompletedAt, entry.userCompletedAt),
            sql`${threads.scheduledDeletionAt} IS ${entry.scheduledDeletionAt}`,
            isNull(threads.deletedAt),
            sql`${threads.cleanupState} IS NOT 'running'`,
          )));
        if (result.changes > 0) changed.push(entry.id);
      }
      for (const id of changed) {
        tx.delete(cleanupJobs)
          .where(and(eq(cleanupJobs.threadId, id), eq(cleanupJobs.kind, "retention")))
          .run();
      }
      return changed;
    });
    return changedIds
      .map((id) => this.findById(id))
      .filter((thread): thread is Thread => thread !== null);
  }

  /** Clear user-completion metadata in one transaction-safe statement. */
  reopen(id: string, reopenedAt = new Date().toISOString()): Thread | null {
    return this.orm.transaction((tx) => {
      const result = runChanges(tx.update(threads)
        .set({
          userCompletedAt: null,
          scheduledDeletionAt: null,
          cleanupState: null,
          cleanupReason: null,
          updatedAt: sql`CASE WHEN ${threads.userCompletedAt} IS NULL THEN ${threads.updatedAt} ELSE ${reopenedAt} END`,
        })
        .where(and(
          eq(threads.id, id),
          isNull(threads.deletedAt),
          sql`${threads.cleanupState} IS NOT 'running'`,
          sql`NOT (
            ${threads.cleanupState} = 'blocked'
            AND EXISTS (
              SELECT 1 FROM ${cleanupJobs}
              WHERE ${cleanupJobs.threadId} = ${threads.id}
                AND ${cleanupJobs.kind} = 'retention'
            )
          )`,
        ))
        );
      if (result.changes === 0) return null;
      tx.delete(cleanupJobs)
        .where(and(eq(cleanupJobs.threadId, id), eq(cleanupJobs.kind, "retention")))
        .run();
      return this.findById(id);
    });
  }

  /** Claim one queued retention cleanup immediately before destructive work starts. */
  claimRetentionCleanup(id: string, nowIso: string): Thread | null {
    const result = runChanges(this.orm.update(threads)
      .set({ cleanupState: "running", cleanupReason: null })
      .where(and(
        eq(threads.id, id),
        isNull(threads.deletedAt),
        isNotNull(threads.userCompletedAt),
        isNotNull(threads.scheduledDeletionAt),
        lte(threads.scheduledDeletionAt, nowIso),
        inArray(threads.cleanupState, ["queued", "retrying", "running"]),
      ))
      );
    return result.changes > 0 ? this.findById(id) : null;
  }

  /** Clear a stale queued state after its deadline or completion state changed. */
  releaseRetentionCleanup(id: string): void {
    this.orm.update(threads)
      .set({ cleanupState: null, cleanupReason: null })
      .where(and(
        eq(threads.id, id),
        inArray(threads.cleanupState, ["queued", "retrying"]),
      ))
      .run();
  }

  /** Persist a user-safe terminal reason while retaining the completed thread. */
  blockRetentionCleanup(id: string, reason: string): Thread | null {
    this.orm.update(threads)
      .set({ cleanupState: "blocked", cleanupReason: reason.slice(0, 240) })
      .where(and(
        eq(threads.id, id),
        isNull(threads.deletedAt),
        isNotNull(threads.userCompletedAt),
      ))
      .run();
    return this.findById(id);
  }

  /** Return a failed retention cleanup to the persisted retry queue. */
  retryRetentionCleanup(id: string, reason: string): Thread | null {
    this.orm.update(threads)
      .set({
        cleanupState: sql`CASE
          WHEN ${threads.cleanupState} = 'running' THEN 'running'
          ELSE 'retrying'
        END`,
        cleanupReason: reason.slice(0, 240),
      })
      .where(and(
        eq(threads.id, id),
        isNull(threads.deletedAt),
        isNotNull(threads.userCompletedAt),
      ))
      .run();
    return this.findById(id);
  }

  /** Check whether blocked finalization still owns a persisted retention job. */
  hasRetentionCleanupJob(id: string): boolean {
    const row = this.orm
      .select({ found: sql<number>`1` })
      .from(cleanupJobs)
      .where(and(eq(cleanupJobs.threadId, id), eq(cleanupJobs.kind, "retention")))
      .limit(1)
      .get();
    return row?.found === 1;
  }

  /** Set the worktree filesystem path for a thread unless cleanup owns the thread. */
  updateWorktreePath(id: string, worktreePath: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm.update(threads)
      .set({ worktreePath, updatedAt: now })
      .where(and(
        eq(threads.id, id),
        isNull(threads.deletedAt),
        sql`${threads.cleanupState} IS NOT 'running'`,
      ))
      );

    return result.changes > 0;
  }

  /** Clear a thread's worktree filesystem path unless cleanup owns the thread. */
  clearWorktreePath(id: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm.update(threads)
      .set({ worktreePath: null, updatedAt: now })
      .where(and(
        eq(threads.id, id),
        isNull(threads.deletedAt),
        sql`${threads.cleanupState} IS NOT 'running'`,
      ))
      );

    return result.changes > 0;
  }

  /** Mark a thread as a named-branch checkout after creating a branch in place. */
  updateCheckoutToNamedBranch(id: string, branch: string): Thread | null {
    const now = new Date().toISOString();
    const result = runChanges(this.orm.update(threads)
      .set({ branch, checkoutState: "named", updatedAt: now })
      .where(eq(threads.id, id))
      );
    if (result.changes === 0) return null;
    return this.findById(id);
  }

  /**
   * Persist an externally observed checkout state for a worktree thread.
   * Clears stale PR metadata only when the branch or checkout discriminator changed.
   */
  updateCheckoutFromHead(
    id: string,
    branch: string,
    checkoutState: "named" | "branchless",
    baseBranch: string | null,
  ): { thread: Thread; changed: boolean } | null {
    const current = this.findById(id);
    if (!current) return null;

    const changed =
      current.branch !== branch || current.checkout_state !== checkoutState;
    const nextBaseBranch = resolveNextBaseBranch(current, checkoutState, baseBranch);
    if (
      !changed &&
      current.base_branch === nextBaseBranch
    ) {
      return { thread: current, changed: false };
    }

    const now = new Date().toISOString();
    this.orm
      .update(threads)
      .set({
        branch,
        checkoutState,
        baseBranch: nextBaseBranch,
        prNumber: sql`CASE WHEN ${changed ? 1 : 0} THEN NULL ELSE ${threads.prNumber} END`,
        prStatus: sql`CASE WHEN ${changed ? 1 : 0} THEN NULL ELSE ${threads.prStatus} END`,
        updatedAt: now,
      })
      .where(eq(threads.id, id))
      .run();

    const thread = this.findById(id);
    return thread ? { thread, changed } : null;
  }

  /** Soft-delete a thread by setting deleted_at and status to "deleted". */
  softDelete(id: string): boolean {
    const now = new Date().toISOString();
    return this.orm.transaction((tx) => {
      const result = runChanges(tx
        .update(threads)
        .set({ deletedAt: now, status: "deleted", updatedAt: now })
        .where(eq(threads.id, id))
        );
      if (result.changes > 0) {
        tx.update(pullRequestReviewLinks)
          .set({ primaryThreadId: null, updatedAt: now })
          .where(eq(pullRequestReviewLinks.primaryThreadId, id))
          .run();
        tx.update(threads)
          .set({ delegationCoordinatorThreadId: null, updatedAt: now })
          .where(and(
            eq(threads.delegationCoordinatorThreadId, id),
            sql`${threads.workspaceId} != (SELECT workspace_id FROM threads WHERE id = ${id})`,
          ))
          .run();
      }
      return result.changes > 0;
    });
  }

  /** Permanently remove a thread record from the database. */
  hardDelete(id: string, options: { preserveActiveDescendants?: boolean } = {}): boolean {
    return this.db.transaction(() => {
      if (options.preserveActiveDescendants) this.detachActiveDescendants(id);
      // TEMP queue lives only on this connection, so it stays outside the drizzle schema.
      this.db.exec(`
        DROP TABLE IF EXISTS canonical_thread_delete_queue;
        CREATE TEMP TABLE canonical_thread_delete_queue (
          id TEXT PRIMARY KEY NOT NULL,
          child_cursor TEXT
        )
      `);
      const enqueue = this.db.prepare(
        "INSERT OR IGNORE INTO canonical_thread_delete_queue (id, child_cursor) VALUES (?, NULL)",
      );
      enqueue.run(id);
      const selectBatch = this.db.prepare(`
        SELECT id, child_cursor
        FROM canonical_thread_delete_queue
        ORDER BY id
        LIMIT ?
      `);
      const selectChildren = this.db.prepare(`
        SELECT id
        FROM threads
        WHERE parent_thread_id = ?
          AND (? IS NULL OR id > ?)
        ORDER BY id
        LIMIT ?
      `);
      const deleteActions = this.db.prepare(`
        DELETE FROM canonical_collaboration_actions
        WHERE source_thread_id = ? OR target_thread_id = ?
      `);
      const deleteThread = this.db.prepare("DELETE FROM threads WHERE id = ?");
      const dequeue = this.db.prepare("DELETE FROM canonical_thread_delete_queue WHERE id = ?");
      const updateCursor = this.db.prepare(
        "UPDATE canonical_thread_delete_queue SET child_cursor = ? WHERE id = ?",
      );
      let deletedRoot = false;
      while (true) {
        const batch = selectBatch.all(CANONICAL_CHILD_DELETE_BATCH_SIZE) as Array<{
          id: string;
          child_cursor: string | null;
        }>;
        if (batch.length === 0) break;
        for (const row of batch) {
          const children = selectChildren.all(
            row.id,
            row.child_cursor,
            row.child_cursor,
            CANONICAL_CHILD_DELETE_BATCH_SIZE,
          ) as Array<{ id: string }>;
          for (const child of children) enqueue.run(child.id);
          if (children.length === CANONICAL_CHILD_DELETE_BATCH_SIZE) {
            updateCursor.run(children[children.length - 1]!.id, row.id);
            continue;
          }
          deleteActions.run(row.id, row.id);
          const result = deleteThread.run(row.id);
          deletedRoot ||= row.id === id && result.changes > 0;
          dequeue.run(row.id);
        }
      }
      return deletedRoot;
    })();
  }

  // Self-referencing recursive CTE stays raw; drizzle has no readable equivalent.
  private detachActiveDescendants(rootThreadId: string): void {
    const activeDescendants = this.db.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM threads WHERE parent_thread_id = ?
         UNION
         SELECT child.id
         FROM threads AS child
         JOIN descendants AS parent ON child.parent_thread_id = parent.id
       ), active_descendants(id) AS (
         SELECT thread.id
         FROM threads AS thread
         JOIN descendants ON descendants.id = thread.id
         WHERE thread.deleted_at IS NULL
           AND thread.user_completed_at IS NULL
           AND ${independentThreadClause("thread")}
       )
       SELECT active.id
       FROM active_descendants AS active
       JOIN threads AS thread ON thread.id = active.id
       WHERE thread.parent_thread_id NOT IN (SELECT id FROM active_descendants)`,
    ).all(rootThreadId) as Array<{ id: string }>;
    if (activeDescendants.length === 0) return;

    const ids = activeDescendants.map((thread) => thread.id);
    const now = new Date().toISOString();
    this.orm.update(threads)
      .set({ parentThreadId: null, forkedFromMessageId: null, updatedAt: now })
      .where(inArray(threads.id, ids))
      .run();
    this.orm.update(canonicalAgentThreads)
      .set({
        parentThreadId: null,
        rootThreadId: sql`${canonicalAgentThreads.id}`,
        owningParentThreadId: null,
        updatedAt: now,
      })
      .where(inArray(canonicalAgentThreads.id, ids))
      .run();
  }

  /** Update the provider associated with a thread. Returns true if a row was changed. */
  updateProvider(id: string, provider: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ provider, updatedAt: now })
      .where(eq(threads.id, id))
      );

    return result.changes > 0;
  }

  /** Update the model associated with a thread. Returns true if a row was changed. */
  updateModel(id: string, model: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ model, updatedAt: now })
      .where(eq(threads.id, id))
      );

    return result.changes > 0;
  }

  /** Store the SDK-assigned session ID for later resume. Returns true if a row was changed. */
  updateSdkSessionId(id: string, sdkSessionId: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ sdkSessionId, updatedAt: now })
      .where(eq(threads.id, id))
      );

    return result.changes > 0;
  }

  /** Clear the SDK session ID for a thread. Returns true if a row was changed. */
  clearSdkSessionId(id: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ sdkSessionId: null, updatedAt: now })
      .where(eq(threads.id, id))
      );

    return result.changes > 0;
  }

  /** Link a GitHub PR to a thread. Returns true if a row was changed. */
  updatePr(id: string, prNumber: number, prStatus: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ prNumber, prStatus, updatedAt: now })
      .where(eq(threads.id, id))
      );

    return result.changes > 0;
  }

  /** Persist the latest context window usage for a thread.
   * Always updates last_context_tokens. Only updates context_window when provided. */
  updateContextUsage(id: string, lastContextTokens: number, contextWindow?: number): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({
        lastContextTokens,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        updatedAt: now,
      })
      .where(eq(threads.id, id))
      );
    return result.changes > 0;
  }

  /** Persist model, provider, and supplied composer settings in one atomic update. */
  updateSettings(id: string, settings: ThreadSettings): boolean {
    const set = buildSettingsSet(settings);
    if (Object.keys(set).length === 0) return false;

    const result = runChanges(this.orm
      .update(threads)
      .set({ ...set, updatedAt: new Date().toISOString() })
      .where(eq(threads.id, id))
      );
    return result.changes > 0;
  }

  /** Update a thread's display title. Returns true if a row was changed. */
  updateTitle(id: string, title: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ title, updatedAt: now })
      .where(eq(threads.id, id))
      );

    return result.changes > 0;
  }

  /** Persist the latest compaction summary for a thread. Overwrites any previous value. */
  updateCompactSummary(threadId: string, summary: string): void {
    this.orm
      .update(threads)
      .set({ lastCompactSummary: summary, updatedAt: new Date().toISOString() })
      .where(eq(threads.id, threadId))
      .run();
  }

  /**
   * Count active (non-deleted) threads for each workspace id in the list.
   * Returns a Map keyed by workspace id. Workspace ids with no active threads are omitted.
   */
  countActiveByWorkspaceIds(ids: string[]): Map<string, number> {
    if (ids.length === 0) return new Map();
    const rows = this.orm
      .select({ id: threads.workspaceId, n: sql<number>`COUNT(*)` })
      .from(threads)
      .where(and(
        inArray(threads.workspaceId, ids),
        isNull(threads.deletedAt),
        isNull(threads.userCompletedAt),
        canonicalChildVisibility,
      ))
      .groupBy(threads.workspaceId)
      .all();
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  /** Set lineage fields on a thread. Used when thread creation is handled by ThreadService. */
  updateLineage(id: string, parentThreadId: string, forkedFromMessageId: string): boolean {
    const now = new Date().toISOString();
    const result = runChanges(this.orm
      .update(threads)
      .set({ parentThreadId, forkedFromMessageId, updatedAt: now })
      .where(eq(threads.id, id))
      );
    return result.changes > 0;
  }

  /** Persist delegation provenance after a delegated thread is created. */
  updateDelegationLineage(
    id: string,
    lineage: {
      coordinatorThreadId: string;
      creatorTurnId: string;
      creatorToolCallId: string;
      creationKind: "thread_delegation";
      integrationId?: string;
    },
  ): boolean {
    const result = runChanges(this.orm
      .update(threads)
      .set({
        delegationCoordinatorThreadId: lineage.coordinatorThreadId,
        delegationCreatorTurnId: lineage.creatorTurnId,
        delegationCreatorToolCallId: lineage.creatorToolCallId,
        delegationCreationKind: lineage.creationKind,
        createdByIntegrationId: lineage.integrationId ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(threads.id, id))
      );
    return result.changes > 0;
  }

  /** Read persisted delegation provenance without exposing raw database columns. */
  findDelegationLineage(id: string): ThreadDelegationLineageRecord | null {
    const row = this.orm
      .select({
        delegationCoordinatorThreadId: threads.delegationCoordinatorThreadId,
        delegationCreatorTurnId: threads.delegationCreatorTurnId,
        delegationCreatorToolCallId: threads.delegationCreatorToolCallId,
        delegationCreationKind: threads.delegationCreationKind,
      })
      .from(threads)
      .where(eq(threads.id, id))
      .get();
    if (!row) return null;
    return {
      coordinatorThreadId: row.delegationCoordinatorThreadId,
      creatorTurnId: row.delegationCreatorTurnId,
      creatorToolCallId: row.delegationCreatorToolCallId,
      creationKind: row.delegationCreationKind === "thread_delegation" ? "thread_delegation" : null,
    };
  }

  /** List non-deleted delegated children for one coordinator thread. */
  listDelegationChildren(coordinatorThreadId: string): Array<{
    thread: Thread;
    lineage: ThreadDelegationLineageRecord;
  }> {
    const rows = this.orm
      .select()
      .from(threads)
      .where(and(
        isNull(threads.deletedAt),
        eq(threads.delegationCoordinatorThreadId, coordinatorThreadId),
      ))
      .orderBy(desc(threads.updatedAt), asc(threads.id))
      .all();
    return rows.flatMap((row) => {
      if (
        row.delegationCreationKind !== "thread_delegation"
        || !row.delegationCoordinatorThreadId
        || !row.delegationCreatorTurnId
        || !row.delegationCreatorToolCallId
      ) return [];
      return [{
        thread: rowToThread(row),
        lineage: {
          coordinatorThreadId: row.delegationCoordinatorThreadId,
          creatorTurnId: row.delegationCreatorTurnId,
          creatorToolCallId: row.delegationCreatorToolCallId,
          creationKind: "thread_delegation" as const,
        },
      }];
    });
  }

  /** Persist ownership for a thread created by a paired external integration. */
  updateExternalCreator(id: string, integrationId: string): boolean {
    return runChanges(this.orm
      .update(threads)
      .set({ createdByIntegrationId: integrationId, updatedAt: new Date().toISOString() })
      .where(eq(threads.id, id))).changes > 0;
  }

  /** Count active capacity owned by one paired external integration. */
  countActiveByIntegration(integrationId: string): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(threads)
      .where(and(
        eq(threads.createdByIntegrationId, integrationId),
        isNull(threads.deletedAt),
        inArray(threads.status, ["active", "paused"]),
        canonicalChildVisibility,
      ))
      .get();
    return row!.count;
  }

  /**
   * Find all threads in a workspace that have a worktree_path set (both active and deleted).
   * Used during workspace deletion to know which threads need filesystem cleanup.
   */
  findWorktreeThreadsByWorkspace(workspaceId: string): Thread[] {
    const rows = this.orm
      .select()
      .from(threads)
      .where(and(eq(threads.workspaceId, workspaceId), isNotNull(threads.worktreePath)))
      .all();
    return rows.map(rowToThread);
  }

  /**
   * List ALL threads for a workspace regardless of deletion status.
   * Used during workspace hard-delete reconciliation.
   */
  listAllByWorkspace(workspaceId: string): Thread[] {
    const rows = this.orm
      .select()
      .from(threads)
      .where(eq(threads.workspaceId, workspaceId))
      .all();
    return rows.map(rowToThread);
  }

  /**
   * Nullify parent_thread_id and forked_from_message_id on threads in OTHER workspaces
   * that reference threads in the given workspace. Prevents dangling references
   * when a workspace is deleted.
   */
  nullifyExternalLineage(workspaceId: string): number {
    const result = runChanges(this.orm
      .update(threads)
      .set({
        parentThreadId: null,
        forkedFromMessageId: null,
        delegationCoordinatorThreadId: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(
        sql`${threads.parentThreadId} IN (SELECT id FROM threads WHERE workspace_id = ${workspaceId})`,
        ne(threads.workspaceId, workspaceId),
      ))
      );
    return result.changes;
  }

  /**
   * Count active (non-deleted) threads on a given branch in the same workspace,
   * excluding a specific thread. Used to decide whether a branch is safe to delete.
   */
  countActiveByBranch(threadId: string, branch: string): number {
    const row = this.orm
      .select({ count: sql<number>`COUNT(*)` })
      .from(threads)
      .where(and(
        sql`${threads.workspaceId} = (SELECT workspace_id FROM threads WHERE id = ${threadId})`,
        eq(threads.branch, branch),
        ne(threads.id, threadId),
        isNull(threads.deletedAt),
        canonicalChildVisibility,
      ))
      .get();
    return row!.count;
  }

  /** List bounded active sibling worktree paths for canonical ownership checks. */
  listActiveSiblingWorktreePaths(
    threadId: string,
    limit = MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS,
  ): ActiveWorktreePathSet {
    const boundedLimit = Math.max(
      1,
      Math.min(MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS, Math.trunc(limit)),
    );
    const rows = this.orm
      .select({ worktreePath: threads.worktreePath })
      .from(threads)
      .where(and(
        sql`${threads.workspaceId} = (SELECT workspace_id FROM threads WHERE id = ${threadId})`,
        ne(threads.id, threadId),
        isNull(threads.deletedAt),
        isNotNull(threads.worktreePath),
      ))
      .limit(boundedLimit + 1)
      .all();
    return {
      paths: rows.slice(0, boundedLimit).map((row) => row.worktreePath!),
      truncated: rows.length > boundedLimit,
    };
  }
}
