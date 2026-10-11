/**
 * Runs a Project's cleanup actions headless in a worktree checkout before Mcode removes it.
 */

import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { WorkspaceEnvironmentService } from "../../projects/index.js";
import type { WorkspaceEnvironmentActionCommandResolution } from "../../projects/environment/workspace-environment-service.js";
import type { TerminalCommandCompletion } from "../../terminal/commands/terminal-command-service.js";

/** Longest time one cleanup action may run before Mcode stops it. */
export const CLEANUP_ACTION_TIMEOUT_MS = 120_000;

/** Most output bytes kept from one cleanup action for the log. */
export const CLEANUP_ACTION_OUTPUT_MAX_BYTES = 64 * 1024;

type ReadyResolution = Extract<WorkspaceEnvironmentActionCommandResolution, { kind: "ready" }>;

/**
 * Runs `runOnCleanup` actions in document order, one at a time, and never rejects.
 * Removal must not depend on these actions: a stuck or failing action would otherwise leak the worktree.
 */
@injectable()
export class CleanupActionRunner {
  constructor(
    @inject(WorkspaceEnvironmentService)
    private readonly environment: Pick<WorkspaceEnvironmentService, "resolveCleanupCommands">,
  ) {}

  /** Run the thread's cleanup actions in its checkout, logging each outcome. */
  async run(threadId: string): Promise<void> {
    let resolutions: readonly WorkspaceEnvironmentActionCommandResolution[];
    try {
      resolutions = await this.environment.resolveCleanupCommands(threadId, {
        timeoutMs: CLEANUP_ACTION_TIMEOUT_MS,
        outputMaxBytes: CLEANUP_ACTION_OUTPUT_MAX_BYTES,
      });
    } catch (error) {
      logger.warn("Cleanup actions unavailable", { threadId, error: errorMessage(error) });
      return;
    }
    for (const resolution of resolutions) {
      await this.runOne(threadId, resolution);
    }
  }

  private async runOne(threadId: string, resolution: WorkspaceEnvironmentActionCommandResolution): Promise<void> {
    const actionId = resolution.action.id;
    if (resolution.kind !== "ready") {
      logger.warn("Cleanup action skipped", { threadId, actionId, reason: resolution.kind });
      return;
    }
    if (resolution.approval) {
      await this.skipUnapproved(threadId, resolution);
      return;
    }
    let completion: TerminalCommandCompletion;
    try {
      completion = await resolution.command.start();
    } catch (error) {
      logger.warn("Cleanup action failed", { threadId, actionId, error: errorMessage(error) });
      return;
    }
    logCompletion(threadId, actionId, completion);
  }

  // Never run an unapproved shared (In repo) command headless; release the prepared command instead.
  private async skipUnapproved(threadId: string, resolution: ReadyResolution): Promise<void> {
    await resolution.command.close();
    logger.warn("Cleanup action skipped", { threadId, actionId: resolution.action.id, reason: "approval_required" });
  }
}

function logCompletion(threadId: string, actionId: string, completion: TerminalCommandCompletion): void {
  const exitCode = completion.kind === "exited" ? completion.exitCode : null;
  if (completion.kind === "exited" && exitCode === 0) {
    logger.info("Cleanup action finished", { threadId, actionId, exitCode });
    return;
  }
  logger.warn("Cleanup action failed", {
    threadId,
    actionId,
    outcome: completion.kind,
    exitCode,
    output: completion.output,
    outputTruncated: completion.outputTruncated,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
