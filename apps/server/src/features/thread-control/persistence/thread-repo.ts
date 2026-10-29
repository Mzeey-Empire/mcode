import { inject, injectable } from "tsyringe";
import type { Thread } from "@mcode/contracts/models/thread";
import type { Database } from "bun:sqlite";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { ThreadStore, MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS } from "./thread-store.js";
import { threadWriteOperations } from "./thread-write-operations.js";
import type { ThreadAttentionService } from "../attention/thread-attention-service.js";
import { broadcast } from "../../../application/transport/push.js";
import type { PullRequestLinkFunnel } from "../../pull-requests/links/pull-request-link-funnel.js";
export type { ActiveWorktreePathSet, CompletedThreadRetentionRecord, CompletedThreadDeadlineUpdate } from "./thread-store.js";
export { MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS } from "./thread-store.js";

/** Read-only queries and committed mutations for ThreadRepo. */
@injectable()
export class ThreadRepo {
  /** Read-model invalidation connected by the application composition root. */
  attention?: Pick<ThreadAttentionService, "invalidate">;
  /** Committed checkout link clears are published by the same PR funnel as observations. */
  pullRequests?: Pick<PullRequestLinkFunnel, "publishCommitted">;
  private readonly reader: ThreadStore;

  constructor(@inject("Database") db: Database, @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter) {
    this.reader = new ThreadStore(db);
  }

  async create(workspaceId: Parameters<ThreadStore["create"]>[0], title: Parameters<ThreadStore["create"]>[1], mode: Parameters<ThreadStore["create"]>[2], branch: Parameters<ThreadStore["create"]>[3], worktreeManaged: Parameters<ThreadStore["create"]>[4] = true, provider: Parameters<ThreadStore["create"]>[5] = "claude", lineage?: Parameters<ThreadStore["create"]>[6], checkoutState: Parameters<ThreadStore["create"]>[7] = "named", baseBranch: Parameters<ThreadStore["create"]>[8] = null): Promise<ReturnType<ThreadStore["create"]>> {
    const thread = await this.writer.execute(threadWriteOperations.create, [workspaceId, title, mode, branch, worktreeManaged, provider, lineage, checkoutState, baseBranch]);
    broadcast("thread.created", { thread });
    return thread;
  }

  /** Read the complete sidebar index across workspaces without a row cap. */
  listAll(): ReturnType<ThreadStore["listAll"]> {
    return this.reader.listAll();
  }

  findById(id: Parameters<ThreadStore["findById"]>[0], options: Parameters<ThreadStore["findById"]>[1] = {}): ReturnType<ThreadStore["findById"]> {
    return this.reader.findById(id, options);
  }

  listByWorkspace(workspaceId: Parameters<ThreadStore["listByWorkspace"]>[0], limit: Parameters<ThreadStore["listByWorkspace"]>[1] = 100): ReturnType<ThreadStore["listByWorkspace"]> {
    return this.reader.listByWorkspace(workspaceId, limit);
  }

  listRecent(limit: Parameters<ThreadStore["listRecent"]>[0] = 12): ReturnType<ThreadStore["listRecent"]> {
    return this.reader.listRecent(limit);
  }

  search(opts: Parameters<ThreadStore["search"]>[0]): ReturnType<ThreadStore["search"]> {
    return this.reader.search(opts);
  }

  updateStatus(id: Parameters<ThreadStore["updateStatus"]>[0], status: Parameters<ThreadStore["updateStatus"]>[1]): Promise<ReturnType<ThreadStore["updateStatus"]>> {
    return this.writer.execute(threadWriteOperations.updateStatus, [id, status]);
  }

  /** Commit the terminal facts before publishing changed attention. */
  async recordTurnOutcome(...input: Parameters<ThreadStore["recordTurnOutcome"]>): Promise<boolean> {
    const changed = await this.writer.execute(threadWriteOperations.recordTurnOutcome, input);
    if (changed) this.publishPlanPhase(input[0]);
    return changed;
  }

  /** Commit a monotonic advance to the turn activity clock. */
  advanceActivity(id: string, at: string): Promise<boolean> {
    return this.writer.execute(threadWriteOperations.advanceActivity, [id, at]);
  }

  /** Publish completion only after its lifecycle write commits. */
  async complete(id: Parameters<ThreadStore["complete"]>[0], completedAt: Parameters<ThreadStore["complete"]>[1], scheduledDeletionAt: Parameters<ThreadStore["complete"]>[2]): Promise<ReturnType<ThreadStore["complete"]>> {
    const previous = this.findById(id);
    const thread = await this.writer.execute(threadWriteOperations.complete, [id, completedAt, scheduledDeletionAt]);
    if (thread && previous?.user_completed_at === null) broadcast("thread.lifecycleChanged", { thread });
    return thread;
  }

  listCompletedRetentionRecords(afterId: Parameters<ThreadStore["listCompletedRetentionRecords"]>[0] = null, limit: Parameters<ThreadStore["listCompletedRetentionRecords"]>[1] = 100): ReturnType<ThreadStore["listCompletedRetentionRecords"]> {
    return this.reader.listCompletedRetentionRecords(afterId, limit);
  }

  updateCompletedThreadDeadlines(updates: Parameters<ThreadStore["updateCompletedThreadDeadlines"]>[0]): Promise<ReturnType<ThreadStore["updateCompletedThreadDeadlines"]>> {
    return this.writer.execute(threadWriteOperations.updateCompletedThreadDeadlines, [updates]);
  }

  /** Publish reopen only after its lifecycle write commits. */
  async reopen(id: Parameters<ThreadStore["reopen"]>[0], reopenedAt: Parameters<ThreadStore["reopen"]>[1] = new Date().toISOString()): Promise<ReturnType<ThreadStore["reopen"]>> {
    const previous = this.findById(id);
    const thread = await this.writer.execute(threadWriteOperations.reopen, [id, reopenedAt]);
    if (thread && previous?.user_completed_at != null) broadcast("thread.lifecycleChanged", { thread });
    return thread;
  }

  claimRetentionCleanup(id: Parameters<ThreadStore["claimRetentionCleanup"]>[0], nowIso: Parameters<ThreadStore["claimRetentionCleanup"]>[1]): Promise<ReturnType<ThreadStore["claimRetentionCleanup"]>> {
    return this.writer.execute(threadWriteOperations.claimRetentionCleanup, [id, nowIso]);
  }

  releaseRetentionCleanup(id: Parameters<ThreadStore["releaseRetentionCleanup"]>[0]): Promise<ReturnType<ThreadStore["releaseRetentionCleanup"]>> {
    return this.writer.execute(threadWriteOperations.releaseRetentionCleanup, [id]);
  }

  blockRetentionCleanup(id: Parameters<ThreadStore["blockRetentionCleanup"]>[0], reason: Parameters<ThreadStore["blockRetentionCleanup"]>[1]): Promise<ReturnType<ThreadStore["blockRetentionCleanup"]>> {
    return this.writer.execute(threadWriteOperations.blockRetentionCleanup, [id, reason]);
  }

  retryRetentionCleanup(id: Parameters<ThreadStore["retryRetentionCleanup"]>[0], reason: Parameters<ThreadStore["retryRetentionCleanup"]>[1]): Promise<ReturnType<ThreadStore["retryRetentionCleanup"]>> {
    return this.writer.execute(threadWriteOperations.retryRetentionCleanup, [id, reason]);
  }

  hasRetentionCleanupJob(id: Parameters<ThreadStore["hasRetentionCleanupJob"]>[0]): ReturnType<ThreadStore["hasRetentionCleanupJob"]> {
    return this.reader.hasRetentionCleanupJob(id);
  }

  updateWorktreePath(id: Parameters<ThreadStore["updateWorktreePath"]>[0], worktreePath: Parameters<ThreadStore["updateWorktreePath"]>[1]): Promise<ReturnType<ThreadStore["updateWorktreePath"]>> {
    return this.writer.execute(threadWriteOperations.updateWorktreePath, [id, worktreePath]);
  }

  clearWorktreePath(id: Parameters<ThreadStore["clearWorktreePath"]>[0]): Promise<ReturnType<ThreadStore["clearWorktreePath"]>> {
    return this.writer.execute(threadWriteOperations.clearWorktreePath, [id]);
  }

  async updateCheckoutToNamedBranch(id: Parameters<ThreadStore["updateCheckoutToNamedBranch"]>[0], branch: Parameters<ThreadStore["updateCheckoutToNamedBranch"]>[1]): Promise<Thread | null> {
    const result = await this.writer.execute(threadWriteOperations.updateCheckoutToNamedBranch, [id, branch]);
    if (result?.pullRequestsChanged) this.pullRequests?.publishCommitted(id, []);
    return result?.thread ?? null;
  }

  async updateCheckoutFromHead(id: Parameters<ThreadStore["updateCheckoutFromHead"]>[0], branch: Parameters<ThreadStore["updateCheckoutFromHead"]>[1], checkoutState: Parameters<ThreadStore["updateCheckoutFromHead"]>[2], baseBranch: Parameters<ThreadStore["updateCheckoutFromHead"]>[3], headSha: Parameters<ThreadStore["updateCheckoutFromHead"]>[4]): Promise<ReturnType<ThreadStore["updateCheckoutFromHead"]>> {
    const result = await this.writer.execute(threadWriteOperations.updateCheckoutFromHead, [id, branch, checkoutState, baseBranch, headSha]);
    if (result?.pullRequestsChanged) this.pullRequests?.publishCommitted(id, []);
    return result;
  }

  softDelete(id: Parameters<ThreadStore["softDelete"]>[0]): Promise<ReturnType<ThreadStore["softDelete"]>> {
    return this.writer.execute(threadWriteOperations.softDelete, [id]);
  }

  hardDelete(id: Parameters<ThreadStore["hardDelete"]>[0], options: Parameters<ThreadStore["hardDelete"]>[1] = {}): Promise<ReturnType<ThreadStore["hardDelete"]>> {
    return this.writer.execute(threadWriteOperations.hardDelete, [id, options]);
  }

  updateProvider(id: Parameters<ThreadStore["updateProvider"]>[0], provider: Parameters<ThreadStore["updateProvider"]>[1]): Promise<ReturnType<ThreadStore["updateProvider"]>> {
    return this.writer.execute(threadWriteOperations.updateProvider, [id, provider]);
  }

  updateModel(id: Parameters<ThreadStore["updateModel"]>[0], model: Parameters<ThreadStore["updateModel"]>[1]): Promise<ReturnType<ThreadStore["updateModel"]>> {
    return this.writer.execute(threadWriteOperations.updateModel, [id, model]);
  }

  updateSdkSessionId(id: Parameters<ThreadStore["updateSdkSessionId"]>[0], providerId: Parameters<ThreadStore["updateSdkSessionId"]>[1], sdkSessionId: Parameters<ThreadStore["updateSdkSessionId"]>[2]): Promise<ReturnType<ThreadStore["updateSdkSessionId"]>> {
    return this.writer.execute(threadWriteOperations.updateSdkSessionId, [id, providerId, sdkSessionId]);
  }

  clearSdkSessionId(id: Parameters<ThreadStore["clearSdkSessionId"]>[0], providerId: Parameters<ThreadStore["clearSdkSessionId"]>[1]): Promise<ReturnType<ThreadStore["clearSdkSessionId"]>> {
    return this.writer.execute(threadWriteOperations.clearSdkSessionId, [id, providerId]);
  }

  updateContextUsage(id: Parameters<ThreadStore["updateContextUsage"]>[0], lastContextTokens: Parameters<ThreadStore["updateContextUsage"]>[1], contextWindow?: Parameters<ThreadStore["updateContextUsage"]>[2]): Promise<ReturnType<ThreadStore["updateContextUsage"]>> {
    return this.writer.execute(threadWriteOperations.updateContextUsage, [id, lastContextTokens, contextWindow]);
  }

  async updateSettings(id: Parameters<ThreadStore["updateSettings"]>[0], settings: Parameters<ThreadStore["updateSettings"]>[1]): Promise<ReturnType<ThreadStore["updateSettings"]>> {
    const changed = await this.writer.execute(threadWriteOperations.updateSettings, [id, settings]);
    if (changed && settings.interaction_mode !== undefined) this.publishPlanPhase(id);
    return changed;
  }

  /**
   * Make `settings.provider` the thread's provider and point `sdk_session_id` at that provider's own
   * session, in one writer transaction. Called once the incoming provider accepted a switching turn.
   */
  commitProviderSwitch(...input: Parameters<ThreadStore["commitProviderSwitch"]>): Promise<ReturnType<ThreadStore["commitProviderSwitch"]>> {
    return this.writer.execute(threadWriteOperations.commitProviderSwitch, input);
  }

  /** Publish planning changes after their transaction has committed. */
  publishPlanPhase(threadId: string): void {
    this.attention?.invalidate(threadId);
    const thread = this.findById(threadId);
    if (thread) broadcast("thread.lifecycleChanged", { thread });
  }

  /** Persist and refresh the planning phase for background and active clients alike. */
  async updatePlanPhase(...input: Parameters<ThreadStore["updatePlanPhase"]>): Promise<void> {
    if (await this.writer.execute(threadWriteOperations.updatePlanPhase, input)) this.publishPlanPhase(input[0]);
  }

  updateTitle(id: Parameters<ThreadStore["updateTitle"]>[0], title: Parameters<ThreadStore["updateTitle"]>[1]): Promise<ReturnType<ThreadStore["updateTitle"]>> {
    return this.writer.execute(threadWriteOperations.updateTitle, [id, title]);
  }

  updateCompactSummary(threadId: Parameters<ThreadStore["updateCompactSummary"]>[0], summary: Parameters<ThreadStore["updateCompactSummary"]>[1]): Promise<ReturnType<ThreadStore["updateCompactSummary"]>> {
    return this.writer.execute(threadWriteOperations.updateCompactSummary, [threadId, summary]);
  }

  countActiveByWorkspaceIds(ids: Parameters<ThreadStore["countActiveByWorkspaceIds"]>[0]): ReturnType<ThreadStore["countActiveByWorkspaceIds"]> {
    return this.reader.countActiveByWorkspaceIds(ids);
  }

  updateLineage(id: Parameters<ThreadStore["updateLineage"]>[0], parentThreadId: Parameters<ThreadStore["updateLineage"]>[1], forkedFromMessageId: Parameters<ThreadStore["updateLineage"]>[2]): Promise<ReturnType<ThreadStore["updateLineage"]>> {
    return this.writer.execute(threadWriteOperations.updateLineage, [id, parentThreadId, forkedFromMessageId]);
  }

  /** Read delegated children hidden from ordinary lists. */
  listDelegatedChildren(coordinatorThreadId: string): ReturnType<ThreadStore["listDelegatedChildren"]> {
    return this.reader.listDelegatedChildren(coordinatorThreadId);
  }

  /** Commit promotion before publishing children as independent threads. */
  async detachActiveDelegatedChildren(coordinatorThreadId: string): Promise<string[]> {
    const ids = await this.writer.execute(threadWriteOperations.detachActiveDelegatedChildren, [coordinatorThreadId]);
    for (const id of ids) {
      const thread = this.findById(id);
      if (thread) broadcast("thread.lifecycleChanged", { thread });
    }
    return ids;
  }

  updateExternalCreator(id: Parameters<ThreadStore["updateExternalCreator"]>[0], integrationId: Parameters<ThreadStore["updateExternalCreator"]>[1]): Promise<ReturnType<ThreadStore["updateExternalCreator"]>> {
    return this.writer.execute(threadWriteOperations.updateExternalCreator, [id, integrationId]);
  }

  countActiveByIntegration(integrationId: Parameters<ThreadStore["countActiveByIntegration"]>[0]): ReturnType<ThreadStore["countActiveByIntegration"]> {
    return this.reader.countActiveByIntegration(integrationId);
  }

  findWorktreeThreadsByWorkspace(workspaceId: Parameters<ThreadStore["findWorktreeThreadsByWorkspace"]>[0]): ReturnType<ThreadStore["findWorktreeThreadsByWorkspace"]> {
    return this.reader.findWorktreeThreadsByWorkspace(workspaceId);
  }

  listAllByWorkspace(workspaceId: Parameters<ThreadStore["listAllByWorkspace"]>[0]): ReturnType<ThreadStore["listAllByWorkspace"]> {
    return this.reader.listAllByWorkspace(workspaceId);
  }

  nullifyExternalLineage(workspaceId: Parameters<ThreadStore["nullifyExternalLineage"]>[0]): Promise<ReturnType<ThreadStore["nullifyExternalLineage"]>> {
    return this.writer.execute(threadWriteOperations.nullifyExternalLineage, [workspaceId]);
  }

  countActiveByBranch(threadId: Parameters<ThreadStore["countActiveByBranch"]>[0], branch: Parameters<ThreadStore["countActiveByBranch"]>[1]): ReturnType<ThreadStore["countActiveByBranch"]> {
    return this.reader.countActiveByBranch(threadId, branch);
  }

  listActiveSiblingWorktreePaths(threadId: Parameters<ThreadStore["listActiveSiblingWorktreePaths"]>[0], limit: Parameters<ThreadStore["listActiveSiblingWorktreePaths"]>[1] = MAX_ACTIVE_WORKTREE_OWNERSHIP_PATHS): ReturnType<ThreadStore["listActiveSiblingWorktreePaths"]> {
    return this.reader.listActiveSiblingWorktreePaths(threadId, limit);
  }
}
