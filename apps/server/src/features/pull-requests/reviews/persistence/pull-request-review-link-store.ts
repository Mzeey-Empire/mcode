/**
 * Durable pull request to Review task linkage data access.
 */

import { inject, injectable } from "tsyringe";
import type { Database } from "bun:sqlite";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { pullRequestReviewLinks } from "../../../../runtime/persistence/sqlite/schema.js";
import { runChanges } from "../../../../runtime/persistence/sqlite/drizzle-changes.js";
import * as NodeCrypto from "node:crypto";
import { ThreadStore } from "../../../thread-control/persistence/thread-store.js";
import { reviewLinkProjection } from "../review-link-projection.js";
import type { CreateReviewTaskInput, ReviewTaskCommit } from "./review-write-operations.js";

/** Stable provider identity for one pull request. */
export interface PullRequestReviewLinkIdentity {
  provider: string;
  repositoryNodeId: string;
  pullRequestNumber: number;
}

/** Persisted local checkout and canonical Review task for one pull request. */
export interface PullRequestReviewLink extends PullRequestReviewLinkIdentity {
  worktreeId: string;
  pullRequestUrl: string;
  pullRequestState: string;
  workspaceId: string;
  worktreePath: string;
  worktreeManaged: boolean;
  headRepositoryNodeId: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  headRef: string;
  headOid: string;
  localBranch: string;
  pushRemote: string;
  pushRef: string;
  managedRemoteName: string | null;
  primaryThreadId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Required values for inserting a pull request Review link. */
export interface CreatePullRequestReviewLinkInput
  extends PullRequestReviewLinkIdentity {
  worktreeId: string;
  pullRequestUrl: string;
  pullRequestState: string;
  workspaceId: string;
  worktreePath: string;
  worktreeManaged: boolean;
  headRepositoryNodeId: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  headRef: string;
  headOid: string;
  localBranch: string;
  pushRemote: string;
  pushRef: string;
  managedRemoteName?: string | null;
  primaryThreadId?: string | null;
}

/** Local checkout metadata used to replace an unowned Review link checkout. */
export interface ReplacePullRequestReviewCheckoutInput {
  pullRequestUrl: string;
  pullRequestState: string;
  workspaceId: string;
  worktreePath: string;
  worktreeManaged: boolean;
  headRepositoryNodeId: string;
  headRepositoryOwner: string;
  headRepositoryName: string;
  headRef: string;
  headOid: string;
  localBranch: string;
  pushRemote: string;
  pushRef: string;
  managedRemoteName?: string | null;
}

/** Mutable remote pull request fields retained with an existing Review link. */
export interface UpdatePullRequestReviewRemoteStateInput {
  pullRequestUrl: string;
  pullRequestState: string;
  headOid?: string;
}

type PullRequestReviewLinkRow = typeof pullRequestReviewLinks.$inferSelect;

function rowToReviewLink(row: PullRequestReviewLinkRow): PullRequestReviewLink {
  return {
    worktreeId: row.worktreeId,
    provider: row.provider,
    repositoryNodeId: row.repositoryNodeId,
    pullRequestNumber: row.pullRequestNumber,
    pullRequestUrl: row.pullRequestUrl,
    pullRequestState: row.pullRequestState,
    workspaceId: row.workspaceId,
    worktreePath: row.worktreePath,
    worktreeManaged: row.worktreeManaged === 1,
    headRepositoryNodeId: row.headRepositoryNodeId,
    headRepositoryOwner: row.headRepositoryOwner,
    headRepositoryName: row.headRepositoryName,
    headRef: row.headRef,
    headOid: row.headOid,
    localBranch: row.localBranch,
    pushRemote: row.pushRemote,
    pushRef: row.pushRef,
    managedRemoteName: row.managedRemoteName,
    primaryThreadId: row.primaryThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function identityWhere(identity: PullRequestReviewLinkIdentity) {
  return and(
    eq(pullRequestReviewLinks.provider, identity.provider),
    eq(pullRequestReviewLinks.repositoryNodeId, identity.repositoryNodeId),
    eq(pullRequestReviewLinks.pullRequestNumber, identity.pullRequestNumber),
  );
}

/** Repository for durable pull request Review task links. */
@injectable()
export class PullRequestReviewLinkStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(@inject("Database") private readonly db: Database) {
    this.orm = drizzle(db);
  }

  /** Commit a complete provisioned Review task and its configured canonical thread. */
  persistReviewTask(input: CreateReviewTaskInput): ReviewTaskCommit {
    return this.withWriteTransaction(() => this.persistReviewTaskRows(input));
  }

  private persistReviewTaskRows(input: CreateReviewTaskInput): ReviewTaskCommit {
    const threads = new ThreadStore(this.db);
    const identity = { provider: input.identity.provider, repositoryNodeId: input.identity.repositoryNodeId, pullRequestNumber: input.identity.number };
    const existing = this.findByIdentity(identity);
    if (existing?.primaryThreadId) {
      const canonical = threads.findById(existing.primaryThreadId);
      if (canonical && canonical.deleted_at === null) throw new Error("A canonical Review task was created concurrently.");
      this.clearPrimaryThreadByThreadId(existing.primaryThreadId);
    }
    const thread = threads.create(input.checkout.workspaceId, input.title, "worktree", input.checkout.localBranch,
      input.checkout.worktreeManaged, input.defaults.provider, undefined, "named", input.baseBranch);
    this.configureReviewThread(threads, thread.id, input);
    const checkout = existing ? this.replaceLocalCheckout(identity, input.checkout) : this.insert({ worktreeId: NodeCrypto.randomUUID(), ...identity, ...input.checkout });
    if (!checkout) throw new Error("The pull request Review link is already owned.");
    const link = this.updatePrimaryThread(identity, thread.id);
    if (!link) throw new Error("Failed to assign the canonical Review task.");
    const configured = threads.findById(thread.id);
    if (!configured) throw new Error("The configured Review task disappeared.");
    return { thread: configured, link: reviewLinkProjection(link) };
  }

  private configureReviewThread(threads: ThreadStore, threadId: string, input: CreateReviewTaskInput): void {
    if (!threads.updateWorktreePath(threadId, input.checkout.worktreePath)) throw new Error("Failed to persist the Review worktree path.");
    if (!threads.updateModel(threadId, input.defaults.model)) throw new Error("Failed to persist the Review task model.");
    if (!threads.updateSettings(threadId, {
      reasoning_level: input.defaults.reasoning, interaction_mode: input.defaults.interactionMode,
      permission_mode: input.defaults.permission, context_window_mode: input.defaults.contextWindow, thinking: input.defaults.thinking,
    })) throw new Error("Failed to persist the Review task settings.");
    if (!threads.updatePr(threadId, input.identity.number, input.checkout.pullRequestState.toUpperCase())) {
      throw new Error("Failed to persist the pull request on the Review task.");
    }
  }

  /** Find the canonical local link for a provider pull request identity. */
  findByIdentity(
    identity: PullRequestReviewLinkIdentity,
  ): PullRequestReviewLink | null {
    const row = this.orm
      .select()
      .from(pullRequestReviewLinks)
      .where(identityWhere(identity))
      .get();
    return row ? rowToReviewLink(row) : null;
  }

  /** Find the Review link whose canonical task is the supplied thread. */
  findByPrimaryThreadId(threadId: string): PullRequestReviewLink | null {
    const row = this.orm
      .select()
      .from(pullRequestReviewLinks)
      .where(eq(pullRequestReviewLinks.primaryThreadId, threadId))
      .get();
    return row ? rowToReviewLink(row) : null;
  }

  /** Find a durable Review identity even when its canonical thread was cleared. */
  findByWorktreePath(
    worktreePath: string,
    pullRequestNumber: number,
  ): PullRequestReviewLink | null {
    const row = this.orm
      .select()
      .from(pullRequestReviewLinks)
      .where(and(
        eq(pullRequestReviewLinks.worktreePath, worktreePath),
        eq(pullRequestReviewLinks.pullRequestNumber, pullRequestNumber),
      ))
      .limit(1)
      .get();
    return row ? rowToReviewLink(row) : null;
  }

  /**
   * Insert a durable Review link.
   *
   * Identity, worktree, and primary-thread conflicts remain database errors so
   * the caller can reread the canonical row after a concurrent attempt wins.
   */
  insert(input: CreatePullRequestReviewLinkInput): PullRequestReviewLink {
    const row = this.orm
      .insert(pullRequestReviewLinks)
      .values({
        worktreeId: input.worktreeId,
        provider: input.provider,
        repositoryNodeId: input.repositoryNodeId,
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
        pullRequestState: input.pullRequestState,
        workspaceId: input.workspaceId,
        worktreePath: input.worktreePath,
        worktreeManaged: input.worktreeManaged ? 1 : 0,
        headRepositoryNodeId: input.headRepositoryNodeId,
        headRepositoryOwner: input.headRepositoryOwner,
        headRepositoryName: input.headRepositoryName,
        headRef: input.headRef,
        headOid: input.headOid,
        localBranch: input.localBranch,
        pushRemote: input.pushRemote,
        pushRef: input.pushRef,
        managedRemoteName: input.managedRemoteName ?? null,
        primaryThreadId: input.primaryThreadId ?? null,
      })
      .returning()
      .get();
    return rowToReviewLink(row);
  }

  /**
   * Replace local checkout metadata only when no canonical task owns the link.
   * The stable worktree id and pull request identity remain unchanged.
   */
  replaceLocalCheckout(
    identity: PullRequestReviewLinkIdentity,
    input: ReplacePullRequestReviewCheckoutInput,
  ): PullRequestReviewLink | null {
    const row = this.orm
      .update(pullRequestReviewLinks)
      .set({
        pullRequestUrl: input.pullRequestUrl,
        pullRequestState: input.pullRequestState,
        workspaceId: input.workspaceId,
        worktreePath: input.worktreePath,
        worktreeManaged: input.worktreeManaged ? 1 : 0,
        headRepositoryNodeId: input.headRepositoryNodeId,
        headRepositoryOwner: input.headRepositoryOwner,
        headRepositoryName: input.headRepositoryName,
        headRef: input.headRef,
        headOid: input.headOid,
        localBranch: input.localBranch,
        pushRemote: input.pushRemote,
        pushRef: input.pushRef,
        managedRemoteName: input.managedRemoteName ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(identityWhere(identity), isNull(pullRequestReviewLinks.primaryThreadId)))
      .returning()
      .get();
    return row ? rowToReviewLink(row) : null;
  }

  /** Refresh mutable remote state without replacing local checkout ownership. */
  updateRemoteState(
    identity: PullRequestReviewLinkIdentity,
    input: UpdatePullRequestReviewRemoteStateInput,
  ): PullRequestReviewLink | null {
    const row = this.orm
      .update(pullRequestReviewLinks)
      .set({
        pullRequestUrl: input.pullRequestUrl,
        pullRequestState: input.pullRequestState,
        headOid: sql`COALESCE(${input.headOid ?? null}, ${pullRequestReviewLinks.headOid})`,
        updatedAt: new Date().toISOString(),
      })
      .where(identityWhere(identity))
      .returning()
      .get();
    return row ? rowToReviewLink(row) : null;
  }

  /** Replace or clear the canonical Review task for one pull request identity. */
  updatePrimaryThread(
    identity: PullRequestReviewLinkIdentity,
    primaryThreadId: string | null,
  ): PullRequestReviewLink | null {
    const row = this.orm
      .update(pullRequestReviewLinks)
      .set({
        primaryThreadId,
        updatedAt: new Date().toISOString(),
      })
      .where(identityWhere(identity))
      .returning()
      .get();
    return row ? rowToReviewLink(row) : null;
  }

  /** Clear a deleted thread from any canonical Review link. */
  clearPrimaryThreadByThreadId(threadId: string): boolean {
    const result = runChanges(
      this.orm
        .update(pullRequestReviewLinks)
        .set({
          primaryThreadId: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(pullRequestReviewLinks.primaryThreadId, threadId)),
    );
    return result.changes > 0;
  }

  /** Run related reads and writes under one immediate SQLite transaction. */
  withWriteTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }
}
