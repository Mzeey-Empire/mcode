import type { Database } from "bun:sqlite";
import { WorkspaceStore } from "../../../features/projects/persistence/workspace-store.js";
import { projectLifecycleWriteHandlers } from "../../../features/projects/lifecycle/project-lifecycle-write-operations.js";
import { workspaceWriteOperations } from "../../../features/projects/persistence/workspace-write-operations.js";
import { databaseWriteHandler } from "./database-write-operation.js";
import { sqliteMaintenanceWriteHandlers } from "./sqlite-maintenance-write-operation.js";
import { agentStorageWriteHandlers } from "../../../features/agents/agent-storage-write-handlers.js";
import { turnFinalizationWriteHandlers } from "../../../features/agents/turns/persistence/turn-finalization-write-operations.js";
import { conversationConversionWriteHandlers } from "../../../features/agents/conversation/migrations/conversation-conversion-write-handlers.js";
import { canonicalRuntimeWriteHandlers } from "../../../features/agents/canonical/canonical-runtime-write-handlers.js";
import { parentAssistantTextWriteHandlers } from "../../../features/agents/turns/parent-assistant-text-write-handlers.js";
import { turnConversationWriteHandlers } from "../../../features/agents/turns/turn-conversation-write-operations.js";
import { goalCommandWriteHandlers } from "../../../features/agents/commands/goal-command-write-operations.js";
import { reviewWriteHandlers } from "../../../features/pull-requests/reviews/persistence/review-write-handlers.js";
import { threadStartupWriteHandlers } from "../../../features/thread-startup/thread-startup-state-write-operations.js";
import { sqliteProfileWriteHandlers } from "./performance/sqlite-profile-write-operations.js";
import { worktreeWriteHandlers } from "../../../features/projects/persistence/worktree-write-operations.js";
import { modelCacheWriteHandlers } from "../../../features/providers/models/persistence/model-cache-write-operations.js";
import { providerCatalogSnapshotWriteHandlers } from "../../../features/providers/catalog/persistence/provider-catalog-snapshot-write-operations.js";
import { workspaceTerminalPreferencesWriteHandlers } from "../../../features/terminal/preferences/workspace-terminal-preferences-write-operations.js";
import { terminalCleanupLedgerWriteHandlers } from "../../../features/terminal/cleanup/terminal-cleanup-ledger-write-operations.js";
import { projectActionRunWriteHandlers } from "../../../features/projects/environment/persistence/project-action-run-write-operations.js";
import { workspaceEnvironmentConfigurationWriteHandlers } from "../../../features/projects/environment/persistence/workspace-environment-configuration-write-operations.js";
import { workspaceEnvironmentAutomaticWriteHandlers } from "../../../features/projects/environment/workspace-environment-automatic-write-operations.js";
import { gitCommitRequestWriteHandlers } from "../../../features/projects/git/commits/persistence/git-commit-request-write-operations.js";
import { storeIdentityWriteHandlers } from "../../../features/projects/diffs/snapshots/snapshot-store-identity.js";
import { buildThreadStoreWriteHandlers } from "../../../features/thread-control/persistence/thread-write-handlers.js";
import { buildCleanupJobStoreWriteHandlers } from "../../../features/thread-control/cleanup/persistence/cleanup-job-write-handlers.js";
import { buildThreadControlApprovalStoreWriteHandlers } from "../../../features/thread-control/authority/persistence/thread-control-approval-write-handlers.js";
import { buildThreadControlAuditStoreWriteHandlers } from "../../../features/thread-control/authority/persistence/thread-control-audit-write-handlers.js";
import { buildExternalThreadControlPairingStoreWriteHandlers } from "../../../features/thread-control/external/external-thread-control-pairing-write-handlers.js";

/** Construct the allowlist against the worker connection, retaining existing feature storage logic. */
export function applicationDatabaseHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const workspace = new WorkspaceStore(db);
  const operations = workspaceWriteOperations;
  return new Map([
    ...sqliteMaintenanceWriteHandlers(db),
    ...agentStorageWriteHandlers(db),
    ...projectLifecycleWriteHandlers(db),
    ...turnFinalizationWriteHandlers(db),
    ...conversationConversionWriteHandlers(db),
    ...canonicalRuntimeWriteHandlers(db),
    ...parentAssistantTextWriteHandlers(db),
    ...turnConversationWriteHandlers(db),
    ...goalCommandWriteHandlers(db),
    ...reviewWriteHandlers(db),
    ...threadStartupWriteHandlers(db),
    ...sqliteProfileWriteHandlers(db),
    ...worktreeWriteHandlers(db),
    ...modelCacheWriteHandlers(db),
    ...providerCatalogSnapshotWriteHandlers(db),
    ...workspaceTerminalPreferencesWriteHandlers(db),
    ...terminalCleanupLedgerWriteHandlers(db),
    ...projectActionRunWriteHandlers(db),
    ...workspaceEnvironmentConfigurationWriteHandlers(db),
    ...workspaceEnvironmentAutomaticWriteHandlers(db),
    ...storeIdentityWriteHandlers(db),
    ...gitCommitRequestWriteHandlers(db),
    ...buildThreadStoreWriteHandlers(db),
    ...buildCleanupJobStoreWriteHandlers(db),
    ...buildThreadControlApprovalStoreWriteHandlers(db),
    ...buildThreadControlAuditStoreWriteHandlers(db),
    ...buildExternalThreadControlPairingStoreWriteHandlers(db),
    [operations.create.name, databaseWriteHandler(operations.create, (input) => workspace.create(...input))],
    [operations.prependToSortOrder.name, databaseWriteHandler(operations.prependToSortOrder, (input) => workspace.prependToSortOrder(...input))],
    [operations.reorderToIndex.name, databaseWriteHandler(operations.reorderToIndex, (input) => workspace.reorderToIndex(...input))],
    [operations.rename.name, databaseWriteHandler(operations.rename, (input) => workspace.rename(...input))],
    [operations.setPinned.name, databaseWriteHandler(operations.setPinned, (input) => workspace.setPinned(...input))],
    [operations.touchLastOpened.name, databaseWriteHandler(operations.touchLastOpened, (input) => workspace.touchLastOpened(...input))],
    [operations.removeRecent.name, databaseWriteHandler(operations.removeRecent, (input) => workspace.removeRecent(...input))],
    [operations.softDelete.name, databaseWriteHandler(operations.softDelete, (input) => workspace.softDelete(...input))],
    [operations.hardDelete.name, databaseWriteHandler(operations.hardDelete, (input) => workspace.hardDelete(...input))],
    [operations.touch.name, databaseWriteHandler(operations.touch, (input) => workspace.touch(...input))],
    [operations.setIsGitRepo.name, databaseWriteHandler(operations.setIsGitRepo, (input) => workspace.setIsGitRepo(...input))],
  ]);
}
