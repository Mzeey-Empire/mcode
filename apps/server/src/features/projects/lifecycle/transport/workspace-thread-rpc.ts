import { WS_METHODS, type WorkspaceCreateResult, type WsMethodName } from "@mcode/contracts/ws/methods";
import { type Thread } from "@mcode/contracts/models/thread";
import { logger } from "@mcode/shared";
import * as NodePerfHooks from "node:perf_hooks";
import type { z } from "zod";
import type { GoalLifecycleService } from "../../../agents/goals/goal-lifecycle-service.js";
import { serverWorkTrace } from "../../../agents/diagnostics/server-work-trace.js";
import { broadcast } from "../../../../application/transport/push.js";
import type { GithubService } from "../../../pull-requests/github/github-service.js";
import type { PullRequestLinkFunnel } from "../../../pull-requests/links/pull-request-link-funnel.js";
import type { CiWatcherService } from "../../../pull-requests/status/ci-watcher.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { ThreadCompletionService } from "../../../thread-control/lifecycle/thread-completion-service.js";
import type { ThreadService } from "../../../thread-control/lifecycle/thread-service.js";
import type { ThreadAttentionService } from "../../../thread-control/attention/thread-attention-service.js";
import type { ThreadDeletionTeardownService } from "../../../thread-control/lifecycle/thread-deletion-teardown-service.js";
import type { ProjectActionService } from "../../environment/project-action-service.js";
import type { WorkspaceEnvironmentService } from "../../environment/workspace-environment-service.js";
import type { GitWatcherService } from "../../git/git-watcher-service.js";
import type { WorkspaceRepo } from "../../persistence/workspace-repo.js";
import type { FilesystemBrowser } from "../filesystem-browser.js";
import type { WorkspaceEnricher } from "../workspace-enricher.js";
import type { WorkspaceService } from "../workspace-service.js";

type WorkspaceThreadRpcMethod = Exclude<
  Extract<WsMethodName, `workspace.${string}` | `thread.${string}` | "filesystem.browse">,
  | `workspace.environment.${string}`
  | `workspace.icon.${string}`
  | `thread.control.${string}`
  | `thread.startup.${string}`
  | "thread.getTasks"
>;

type WorkspaceThreadRpcParamsByMethod = {
  [Method in WorkspaceThreadRpcMethod]: z.output<
    ReturnType<typeof WS_METHODS>[Method]["params"]
  >;
};

type WorkspaceThreadRpcHandlerMap = {
  [Method in WorkspaceThreadRpcMethod]: (
    deps: WorkspaceThreadRouterDeps,
    params: WorkspaceThreadRpcParamsByMethod[Method],
  ) => Promise<unknown> | unknown;
};

/** Defines the feature services required to route validated Workspace and Thread RPC calls. */
export interface WorkspaceThreadRouterDeps {
  workspaceService: Pick<WorkspaceService, "create" | "delete" | "findById" | "forceDelete" | "list" | "rename" | "reorder">;
  workspaceEnvironmentService: Pick<
    WorkspaceEnvironmentService,
    "beginThreadDeletion" | "beginWorkspaceDeletion" | "cancelSetupForThread" | "cancelSetupForWorkspace" | "removeWorkspaceApprovals" | "read"
  >;
  projectActionService: Pick<ProjectActionService, "beginThreadTeardown" | "beginWorkspaceTeardown" | "reopenThread" | "stopForThread">;
  threadService: Pick<ThreadService, "create" | "delete" | "findById" | "list" | "listRecent" | "search" | "updateSettings" | "updateTitle">;
  threadAttentionService: Pick<ThreadAttentionService, "listInteresting" | "acknowledgeSeen">;
  goalLifecycleService: Pick<GoalLifecycleService, "clear" | "get">;
  threadCompletionService: Pick<ThreadCompletionService, "cleanupBlockedCount" | "complete" | "reopen" | "retryCleanup">;
  threadDeletionTeardownService: Pick<ThreadDeletionTeardownService, "teardownThread">;
  threadRepo: Pick<ThreadRepo, "findById" | "listAllByWorkspace" | "listAll">;
  workspaceRepo: Pick<WorkspaceRepo, "findById" | "removeRecent" | "setPinned" | "touchLastOpened">;
  gitWatcherService: Pick<GitWatcherService, "retryWatch" | "unwatchThreadWorktree" | "unwatchWorkspace" | "watchThreadWorktree" | "watchWorkspace">;
  githubService: Pick<GithubService, "cancelForRepoPath" | "listBranchPrs" | "getPullRequestWatchSnapshots">;
  pullRequestLinkFunnel: Pick<PullRequestLinkFunnel, "observe">;
  ciWatcherService: Pick<CiWatcherService, "refresh" | "teardownThread" | "unwatch" | "watch">;
  enricher: Pick<WorkspaceEnricher, "enrich">;
  filesystemBrowser: Pick<FilesystemBrowser, "browse">;
}

const workspaceThreadHandlers = {
  "workspace.list": (deps) => deps.workspaceService.list(),
  "workspace.create": createWorkspace,
  "workspace.rename": (deps, params) => deps.workspaceService.rename(params.id, params.name),
  "workspace.delete": (deps, params) => deleteWorkspace(deps, params.id),
  "workspace.forceDelete": (deps, params) => forceDeleteWorkspace(deps, params.id),
  "workspace.pin": async (deps, params) => {
    await deps.workspaceRepo.setPinned(params.id, params.pinned);
    return { ok: true as const };
  },
  "workspace.removeRecent": async (deps, params) => {
    await deps.workspaceRepo.removeRecent(params.id);
    return { ok: true as const };
  },
  "workspace.touchLastOpened": async (deps, params) => {
    await deps.workspaceRepo.touchLastOpened(params.id);
    const workspace = deps.workspaceService.findById(params.id);
    if (workspace && !workspace.is_git_repo) deps.gitWatcherService.retryWatch(workspace.id, workspace.path);
    return { ok: true as const };
  },
  "workspace.reorder": async (deps, params) => {
    await deps.workspaceService.reorder(params.id, params.newIndex);
    broadcast("workspace.orderChanged", {});
    return { ok: true as const };
  },
  "workspace.enrich": enrichWorkspaces,
  "filesystem.browse": (deps, params) => deps.filesystemBrowser.browse(params.path),
  "thread.listAll": (deps) => deps.threadRepo.listAll(),
  "thread.recent": (deps, params) => deps.threadService.listRecent(params.limit),
  "thread.create": createThread,
  "thread.delete": (deps, params) => deleteThread(deps, params),
  "thread.complete": (deps, params) => deps.threadCompletionService.complete(params.threadId, params.holdMs),
  "thread.reopen": (deps, params) => reopenThread(deps, params.threadId),
  "thread.cleanupBlockedCount": (deps) => deps.threadCompletionService.cleanupBlockedCount(),
  "thread.retryCleanup": (deps, params) => retryThreadCleanup(deps, params.threadId),
  "thread.updateTitle": (deps, params) => deps.threadService.updateTitle(params.threadId, params.title),
  "thread.updateSettings": updateThreadSettings,
  "thread.listAttention": (deps) => deps.threadAttentionService.listInteresting(),
  "thread.acknowledgeSeen": (deps, params) => deps.threadAttentionService.acknowledgeSeen(params.threadId, params.throughSequence),
  "thread.goal.get": (deps, params) => deps.goalLifecycleService.get(params.threadId),
  "thread.goal.clear": (deps, params) => deps.goalLifecycleService.clear(params.threadId),
  "thread.search": (deps, params) => deps.threadService.search({
    query: params.query,
    filters: params.filters,
    sort: params.sort,
    limit: params.limit,
  }),
  "thread.syncPrs": (deps) => syncThreadPullRequests(deps),
} satisfies WorkspaceThreadRpcHandlerMap;

/** Checks whether a WebSocket method belongs to the Workspace and Thread RPC families. */
export function isWorkspaceThreadRpcMethod(
  method: WsMethodName,
): method is WorkspaceThreadRpcMethod {
  return Object.hasOwn(workspaceThreadHandlers, method);
}

/** Routes validated Workspace and Thread RPC parameters to their feature services. */
export async function routeWorkspaceThreadRpc<Method extends WorkspaceThreadRpcMethod>(
  method: Method,
  params: WorkspaceThreadRpcParamsByMethod[Method],
  deps: WorkspaceThreadRouterDeps,
): Promise<unknown> {
  return await workspaceThreadHandlers[method](deps, params);
}

async function createWorkspace(
  deps: WorkspaceThreadRouterDeps,
  params: WorkspaceThreadRpcParamsByMethod["workspace.create"],
): Promise<WorkspaceCreateResult> {
  const result = await deps.workspaceService.create(params.name, params.path);
  if (!result.ok) return result;
  const { workspace } = result;
  await deps.workspaceEnvironmentService.read(workspace.id);
  try {
    deps.gitWatcherService.watchWorkspace(workspace.id, workspace.path);
  } catch (error) {
    logger.warn("Failed to start branch watcher for workspace", {
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

async function deleteWorkspace(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
): Promise<boolean> {
  return await deleteWorkspaceWithTeardown(
    deps,
    workspaceId,
    (id) => deps.workspaceService.delete(id),
    () => broadcast("workspace.orderChanged", {}),
  );
}

async function forceDeleteWorkspace(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
): Promise<boolean> {
  return await deleteWorkspaceWithTeardown(
    deps,
    workspaceId,
    (id) => deps.workspaceService.forceDelete(id),
    () => {
      broadcast("workspace.deleted", { workspaceId });
      broadcast("workspace.orderChanged", {});
    },
  );
}

async function deleteWorkspaceWithTeardown(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
  removeWorkspace: (workspaceId: string) => Promise<boolean>,
  publishDeleted: () => void,
): Promise<boolean> {
  const releaseDeletionBarrier = deps.workspaceEnvironmentService.beginWorkspaceDeletion(workspaceId);
  const releaseActionAdmission = await deps.projectActionService.beginWorkspaceTeardown(workspaceId);
  try {
    await teardownWorkspaceThreads(deps, workspaceId);
    const deleted = await removeWorkspace(workspaceId);
    if (deleted) {
      await deps.workspaceEnvironmentService.removeWorkspaceApprovals(workspaceId);
      deps.gitWatcherService.unwatchWorkspace(workspaceId);
      publishDeleted();
    }
    return deleted;
  } finally {
    releaseActionAdmission();
    releaseDeletionBarrier();
  }
}

async function enrichWorkspaces(
  deps: WorkspaceThreadRouterDeps,
  params: { ids: string[] },
): Promise<{ items: unknown }> {
  const workspaces = params.ids
    .map((id) => deps.workspaceRepo.findById(id))
    .filter((workspace): workspace is NonNullable<typeof workspace> => workspace !== null && workspace !== undefined)
    .map((workspace) => ({ id: workspace.id, path: workspace.path }));
  return { items: await deps.enricher.enrich(workspaces) };
}

async function createThread(
  deps: WorkspaceThreadRouterDeps,
  params: { workspaceId: string; title: string; mode: string; branch: string },
): Promise<Thread> {
  const started = serverWorkTrace ? NodePerfHooks.performance.now() : 0;
  let threadId: string | undefined;
  try {
    const thread = await deps.threadService.create(
      params.workspaceId,
      params.title,
      params.mode,
      params.branch,
      { branchless: params.mode === "worktree" },
    );
    threadId = thread.id;
    watchReturnedThreadWorktree(deps, thread);
    return thread;
  } finally {
    if (serverWorkTrace) serverWorkTrace.record("thread-create", threadId, undefined, NodePerfHooks.performance.now() - started);
  }
}

function watchReturnedThreadWorktree(
  deps: WorkspaceThreadRouterDeps,
  thread: unknown,
): void {
  const maybeThread = thread as { id?: string; mode?: string; worktree_path?: string | null } | null;
  if (maybeThread?.mode !== "worktree" || !maybeThread.worktree_path || !maybeThread.id) return;
  void Promise.resolve(
    deps.gitWatcherService?.watchThreadWorktree?.(maybeThread.id, maybeThread.worktree_path),
  ).catch((error) => {
    logger.warn("Failed to start thread worktree watcher", {
      threadId: maybeThread.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

async function deleteThread(
  deps: WorkspaceThreadRouterDeps,
  params: { threadId: string; cleanupWorktree: boolean },
): Promise<boolean> {
  return await deps.threadService.delete(params.threadId, params.cleanupWorktree);
}

async function reopenThread(deps: WorkspaceThreadRouterDeps, threadId: string): Promise<Thread> {
  const reopened = await deps.threadCompletionService.reopen(threadId);
  deps.projectActionService.reopenThread(threadId);
  return reopened;
}

async function retryThreadCleanup(deps: WorkspaceThreadRouterDeps, threadId: string): Promise<Thread> {
  const queued = await deps.threadCompletionService.retryCleanup(threadId);
  broadcast("thread.lifecycleChanged", { thread: queued });
  return queued;
}

function updateThreadSettings(
  deps: WorkspaceThreadRouterDeps,
  params: {
    threadId: string;
    reasoningLevel?: string;
    interactionMode?: string;
    orchestrationMode?: string;
    permissionMode?: string;
    contextWindow?: Thread["context_window_mode"];
    thinking?: boolean | null;
    fastMode?: boolean | null;
    defaultOpenInApp?: string | null;
  },
): Promise<boolean> {
  return deps.threadService.updateSettings(params.threadId, {
    reasoning_level: params.reasoningLevel,
    interaction_mode: params.interactionMode,
    orchestration_mode: params.orchestrationMode,
    permission_mode: params.permissionMode,
    context_window_mode: params.contextWindow,
    thinking: params.thinking,
    fast_mode: params.fastMode,
    default_open_in_app: params.defaultOpenInApp,
  });
}

type PrSyncDeps = {
  threadRepo: Pick<ThreadRepo, "listAll" | "findById">;
  workspaceService: Pick<WorkspaceService, "findById">;
  githubService: Pick<GithubService, "listBranchPrs" | "getPullRequestWatchSnapshots">;
  pullRequestLinkFunnel: Pick<PullRequestLinkFunnel, "observe">;
  ciWatcherService: Pick<CiWatcherService, "refresh">;
};

/** Refresh linked PRs across the global thread index, publishing through the funnel. */
export async function syncThreadPullRequests(
  deps: PrSyncDeps,
): Promise<{ checked: number }> {
  const candidates = deps.threadRepo.listAll().filter((thread) =>
    thread.mode === "worktree" && thread.checkout_state === "named",
  );
  const byWorkspace = new Map<string, Thread[]>();
  for (const thread of candidates) {
    const group = byWorkspace.get(thread.workspace_id) ?? [];
    group.push(thread);
    byWorkspace.set(thread.workspace_id, group);
  }
  for (const [workspaceId, threads] of byWorkspace) {
    const workspace = deps.workspaceService.findById(workspaceId);
    if (!workspace?.is_git_repo) continue;
    await syncWorkspacePullRequests(deps, threads, workspace.path);
  }
  return { checked: candidates.length };
}

function unchangedCheckout(deps: PrSyncDeps, previous: Thread): Thread | null {
  const current = deps.threadRepo.findById(previous.id);
  return current?.branch === previous.branch && current.checkout_state === previous.checkout_state
    ? current : null;
}

async function syncWorkspacePullRequests(
  deps: PrSyncDeps,
  threads: Thread[],
  repoPath: string,
): Promise<void> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const targets = threads.flatMap((thread) => thread.pull_requests
    .filter((pr) => pr.state !== "merged" && pr.state !== "closed")
    .map((pr) => ({ threadId: thread.id, prNumber: pr.number, repoPath })));
  const snapshots = targets.length > 0 ? await deps.githubService.getPullRequestWatchSnapshots(targets) : [];
  for (const snapshot of snapshots) {
    const previous = byId.get(snapshot.threadId);
    if (!previous) continue;
    const current = unchangedCheckout(deps, previous);
    if (!current?.pull_requests.some((pr) => pr.number === snapshot.prNumber)) continue;
    await deps.pullRequestLinkFunnel.observe(current.id, [{
      number: snapshot.prNumber, state: snapshot.state, title: snapshot.title, url: snapshot.url,
    }], "sync");
    deps.ciWatcherService.refresh(current.id, snapshot.prNumber, snapshot.checks);
  }
  await Promise.all(threads.map(async (thread) => {
    const prs = await deps.githubService.listBranchPrs(thread.branch, repoPath);
    if (!unchangedCheckout(deps, thread)) return;
    await deps.pullRequestLinkFunnel.observe(thread.id, prs, "sync");
  }));
}

async function teardownWorkspaceThreads(
  deps: WorkspaceThreadRouterDeps,
  workspaceId: string,
): Promise<void> {
  await deps.workspaceEnvironmentService.cancelSetupForWorkspace(workspaceId);
  const threads = deps.threadRepo.listAllByWorkspace(workspaceId);
  const results = await Promise.allSettled(
    threads.map((thread) => teardownWorkspaceThread(deps, thread)),
  );
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length === 0) return;
  throw new Error(
    `Workspace teardown failed for ${workspaceId}: ${failures.map(teardownFailureMessage).join("; ")}`,
  );
}

async function teardownWorkspaceThread(
  deps: WorkspaceThreadRouterDeps,
  thread: Pick<Thread, "id">,
): Promise<void> {
  await deps.threadDeletionTeardownService.teardownThread(thread.id);
}

function teardownFailureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason);
}
