import { delay, instanceCachingFactory, Lifecycle, type DependencyContainer } from "tsyringe";

import {
  ExternalThreadControlMcpRuntime,
  ExternalThreadControlPairingService,
  ThreadCompletionService,
  ThreadControlMutationReservationService,
  ThreadControlService,
  ThreadDeletionTeardownService,
  ThreadTeardownService,
} from "../index.js";
import { McodeSessionAuthority } from "../../mcode-mcp/mcode-session-authority.js";
import { ThreadControlApprovalRepo } from "../authority/persistence/thread-control-approval-repo.js";
import { ThreadControlAuditRepo } from "../authority/persistence/thread-control-audit-repo.js";
import { DelegatedTaskRepo } from "../delegation/delegated-task-repo.js";
import { DelegatedTaskService } from "../delegation/delegated-task-service.js";
import { ThreadLaunchService } from "../launch/thread-launch-service.js";
import { ThreadRepo } from "../persistence/thread-repo.js";
import { ThreadStartupService } from "../../thread-startup/thread-startup-service.js";
import { ThreadStartupFetchDecisions } from "../../thread-startup/thread-startup-fetch-decisions.js";
import { WorkspaceEnvironmentService } from "../../projects/environment/workspace-environment-service.js";
import { GitWorktreeService } from "../../projects/git/git-worktree-service.js";
import { GitRepositoryService } from "../../projects/git/git-repository-service.js";
import { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import { AgentService } from "../../agents/orchestration/agent-service.js";
import { AgentTurnCommandPort } from "../../agents/orchestration/agent-turn-command-port.js";
import { CanonicalAgentBoundary } from "../../agents/canonical/canonical-agent-boundary.js";
import { TurnResumeScheduleStore } from "../../agents/recovery/turn-resume-schedule-store.js";
import { DelegationTargetResolver } from "../../agents/collaboration/delegation-target-resolver.js";
import { ApprovalService } from "../../agents/approvals/approval-service.js";
import type { CancelThreadStartupDeps } from "../../thread-startup/cancel-thread-startup.js";

/** Register thread-control mutation, approval, authority, and lifecycle services. */
export function registerThreadControlServices(container: DependencyContainer): void {
  container.register(ThreadLaunchService, { useFactory: instanceCachingFactory((c) => new ThreadLaunchService({
    threads: c.resolve(ThreadRepo), workspaces: c.resolve(WorkspaceRepo),
    targets: c.resolve(delay(() => DelegationTargetResolver)),
    repository: c.resolve(delay(() => GitRepositoryService)),
    commands: c.resolve(delay(() => AgentTurnCommandPort)),
  })) });
  container.register(DelegatedTaskRepo, { useClass: DelegatedTaskRepo }, { lifecycle: Lifecycle.Singleton });
  container.register<CancelThreadStartupDeps>("CancelThreadStartupDeps", { useFactory: instanceCachingFactory((c) => ({
    threadStartupService: c.resolve(ThreadStartupService),
    threadStartupFetchDecisions: c.resolve(ThreadStartupFetchDecisions),
    workspaceEnvironmentService: c.resolve(delay(() => WorkspaceEnvironmentService)),
    agentService: c.resolve(delay(() => AgentService)),
  })) });
  container.register(DelegatedTaskService, { useFactory: instanceCachingFactory((c) => new DelegatedTaskService({
    tasks: c.resolve(DelegatedTaskRepo), threads: c.resolve(ThreadRepo), startups: c.resolve(ThreadStartupService),
    approvals: c.resolve(ThreadControlApprovalRepo), canonical: c.resolve(CanonicalAgentBoundary),
    resumes: c.resolve(TurnResumeScheduleStore),
    targets: c.resolve(delay(() => DelegationTargetResolver)), git: c.resolve(delay(() => GitWorktreeService)),
    control: c.resolve(delay(() => ThreadControlService)), approvalService: c.resolve(delay(() => ApprovalService)),
    cancellation: c.resolve<CancelThreadStartupDeps>("CancelThreadStartupDeps"),
    commands: c.resolve(delay(() => AgentTurnCommandPort)),
  })) });
  container.register(
    ThreadControlMutationReservationService,
    { useClass: ThreadControlMutationReservationService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlApprovalRepo,
    { useClass: ThreadControlApprovalRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlAuditRepo,
    { useClass: ThreadControlAuditRepo },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadControlService,
    { useClass: ThreadControlService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    McodeSessionAuthority,
    { useClass: McodeSessionAuthority },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ExternalThreadControlPairingService,
    { useClass: ExternalThreadControlPairingService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ExternalThreadControlMcpRuntime,
    { useClass: ExternalThreadControlMcpRuntime },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadTeardownService,
    { useClass: ThreadTeardownService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadDeletionTeardownService,
    { useClass: ThreadDeletionTeardownService },
    { lifecycle: Lifecycle.Singleton },
  );
  container.register(
    ThreadCompletionService,
    { useClass: ThreadCompletionService },
    { lifecycle: Lifecycle.Singleton },
  );
}
