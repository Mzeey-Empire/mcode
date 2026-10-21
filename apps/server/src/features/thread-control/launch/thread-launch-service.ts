import * as NodeCrypto from "node:crypto";
import {
  ThreadLaunchInputSchema, ProviderIdSchema,
  type ThreadLaunchInput, type ThreadLaunchResult, type ThreadLaunchWorkspace, type ThreadControlError, type Thread,
} from "@mcode/contracts";
import type { InternalThreadControlAuthority } from "@mcode/thread-orchestration";
import type { ThreadRepo } from "../persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../projects/persistence/workspace-repo.js";
import type { DelegationTargetResolver, DelegationTargetResolution } from "../../agents/collaboration/delegation-target-resolver.js";
import { OriginFetchError, type GitRepositoryService } from "../../projects/git/git-repository-service.js";
import type { CreateAndSendCommand, CreateAndSendOptions } from "../../agents/turns/thread-creation-coordinator.js";
import { ExistingWorktreePlacementError } from "../../agents/turns/turn-admission-dispatch-coordinator.js";

/** Existing owners used to prepare and start an ordinary thread. */
export interface ThreadLaunchDeps {
  threads: Pick<ThreadRepo, "findById">;
  workspaces: Pick<WorkspaceRepo, "findById">;
  targets: Pick<DelegationTargetResolver, "resolve">;
  repository: Pick<GitRepositoryService, "getCurrentBranch" | "fetchOriginTrackingBranch" | "resolveLocalBranchCommit">;
  commands: {
    createAndSend(command: CreateAndSendCommand, options: CreateAndSendOptions): Promise<Pick<Thread, "id">>;
  };
}

type LaunchRejection = Extract<ThreadLaunchResult, { status: "rejected" }>;
type LaunchModes = Required<Pick<ThreadLaunchInput, "permissionMode" | "interactionMode">>;
interface LaunchPlacement {
  fields: Pick<CreateAndSendCommand, "mode" | "branch" | "existingWorktreePath" | "existingWorktreeBaseBranch" | "worktreeBranchMode">;
  worktreeStart?: CreateAndSendOptions["worktreeStart"];
}

/** Launch ordinary user-owned threads through the first-turn setup gate. */
export class ThreadLaunchService {
  constructor(private readonly deps: ThreadLaunchDeps) {}

  /** Prepare the requested workspace and start a thread within the caller's modes. */
  async launch(authority: InternalThreadControlAuthority, input: ThreadLaunchInput): Promise<ThreadLaunchResult> {
    const parsed = ThreadLaunchInputSchema().parse(input);
    const source = this.deps.threads.findById(authority.sourceThreadId);
    if (!source || source.deleted_at) return rejection("not_found", "Source thread not found");
    const modes = resolveModes(authority, source, parsed);
    if ("status" in modes) return modes;
    const target = await this.resolveTarget(source, parsed);
    if (target.status === "rejected") return target;
    const placement = await this.placement(source.workspace_id, parsed.workspace);
    if ("status" in placement) return placement;
    try {
      const thread = await this.deps.commands.createAndSend({
        workspaceId: source.workspace_id,
        startupId: NodeCrypto.randomUUID(),
        title: parsed.title,
        content: parsed.prompt,
        provider: target.providerId,
        model: target.modelId,
        ...modes,
        ...placement.fields,
        attachments: [],
      }, {
        messageId: NodeCrypto.randomUUID(),
        turn: {
          sourceTurnId: NodeCrypto.randomUUID(),
          sourceThreadId: authority.sourceThreadId,
          sourceProviderId: ProviderIdSchema.parse(authority.sourceProviderId),
          originSourceTurnId: authority.sourceTurnId,
        },
        worktreeStart: placement.worktreeStart,
      });
      return { status: "launched", threadId: thread.id };
    } catch (error) {
      if (error instanceof ExistingWorktreePlacementError) return rejection("invalid_placement", error.message);
      throw error;
    }
  }

  private async resolveTarget(source: Thread, input: ThreadLaunchInput): Promise<Extract<DelegationTargetResolution, { status: "resolved" }> | LaunchRejection> {
    const providerId = input.providerId ?? source.provider;
    const modelId = input.modelId ?? (providerId === source.provider ? source.model : undefined);
    if (!modelId) return rejection("invalid_model", "A model is required for the requested provider");
    const target = await this.deps.targets.resolve({ providerId, modelId });
    if (target.status === "resolved") return target;
    if (target.status === "discovery_failed") return rejection("internal_error", "Provider target discovery failed", true);
    return rejection(target.status === "invalid_provider" ? "invalid_provider" : "invalid_model", "The requested provider and model are unavailable");
  }

  private async placement(workspaceId: string, workspace: ThreadLaunchWorkspace): Promise<LaunchPlacement | LaunchRejection> {
    if (workspace.type === "root") {
      const branch = await this.deps.repository.getCurrentBranch(workspaceId);
      if (!branch) return rejection("invalid_placement", "The project root has no current branch");
      return { fields: { mode: "direct", branch } };
    }
    if (workspace.type === "existing_worktree") {
      return { fields: {
        mode: "worktree",
        existingWorktreePath: workspace.worktreePath,
        existingWorktreeBaseBranch: workspace.baseBranch,
      } };
    }
    const project = this.deps.workspaces.findById(workspaceId);
    if (!project) return rejection("not_found", "Project not found");
    const commit = await this.resolveCommit(project.path, workspace);
    if (typeof commit !== "string") return commit;
    return {
      fields: { mode: "worktree", branch: workspace.baseRef, existingWorktreeBaseBranch: workspace.baseRef, worktreeBranchMode: "branchless" },
      worktreeStart: { commit },
    };
  }

  private async resolveCommit(repoPath: string, workspace: Extract<ThreadLaunchWorkspace, { type: "new_worktree" }>): Promise<string | LaunchRejection> {
    if (workspace.startFromOrigin) {
      try {
        return await this.deps.repository.fetchOriginTrackingBranch(repoPath, workspace.baseRef);
      } catch (error) {
        if (!(error instanceof OriginFetchError)) throw error;
        const missing = error.code === "no_origin" || error.code === "branch_missing";
        return missing ? rejection("invalid_placement", error.message) : rejection("internal_error", error.message, true);
      }
    }
    const commit = await this.deps.repository.resolveLocalBranchCommit(repoPath, workspace.baseRef);
    return commit ?? rejection("invalid_placement", `No local branch ${workspace.baseRef}`);
  }
}

function resolveModes(authority: InternalThreadControlAuthority, source: Thread, input: ThreadLaunchInput): LaunchModes | LaunchRejection {
  if (authority.permissionMode === "supervised" && input.permissionMode === "full") {
    return rejection("forbidden", "The launched thread cannot have broader permissions than its caller");
  }
  const interactionMode = source.interaction_mode ?? "build";
  if (interactionMode === "plan" && input.interactionMode === "build") {
    return rejection("forbidden", "A plan thread cannot launch a build thread");
  }
  return {
    permissionMode: input.permissionMode ?? authority.permissionMode,
    interactionMode: input.interactionMode ?? interactionMode,
  };
}

function rejection(code: ThreadControlError["code"], message: string, retryable = false): LaunchRejection {
  return { status: "rejected", error: { code, message, retryable } };
}
