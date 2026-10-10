/**
 * Writes a commit message for the selected Review paths with the utility model. A failure is
 * reported as a reason; there is never fallback message text.
 */
import { inject, injectable } from "tsyringe";
import type { GitGenerateCommitMessageResult } from "@mcode/contracts";
import { ModelCacheService } from "../../../providers/models/model-cache-service.js";
import { isProviderAvailabilityError } from "../../../providers/availability/provider-availability-errors.js";
import {
  NoCompletionProviderError,
  UtilityCompletionService,
  type UtilityCompletion,
} from "../../../../shared/completion/utility-completion-service.js";
import { gitExitCode } from "../execution/git-failure.js";
import type { GitExecutor } from "../execution/types.js";
import { GitComparisonService } from "../git-comparison-service.js";
import { isLiteralRepoPath } from "../literal-paths.js";
import { buildCommitMessagePrompt, parseCommitMessageResponse } from "./commit-message-prompt.js";

/** How long generation waits for the utility model. Providers have no completion timeout of their own. */
export const COMMIT_MESSAGE_TIMEOUT_MS = 60_000;
const STYLE_SAMPLE_SIZE = 10;

type Failed = Extract<GitGenerateCommitMessageResult, { status: "failed" }>;

/** Generates commit messages from the selected paths' diff. */
@injectable()
export class CommitMessageGenerator {
  constructor(
    @inject("GitExecutor") private readonly gitExecutor: GitExecutor,
    @inject(GitComparisonService) private readonly comparison: Pick<GitComparisonService, "readSelectedPathsDiff">,
    @inject(UtilityCompletionService) private readonly completion: Pick<UtilityCompletionService, "complete">,
    @inject(ModelCacheService) private readonly models: Pick<ModelCacheService, "getCached">,
  ) {}

  /** Generate a subject and body for `paths` in the checkout at `repoPath`. */
  async generate(
    repoPath: string,
    paths: readonly string[],
    timeoutMs = COMMIT_MESSAGE_TIMEOUT_MS,
  ): Promise<GitGenerateCommitMessageResult> {
    const invalid = paths.find((path) => !isLiteralRepoPath(path));
    if (invalid !== undefined) throw new Error(`Invalid repository path: ${invalid}`);
    const diff = await this.comparison.readSelectedPathsDiff(repoPath, paths);
    if (diff.patch.trim().length === 0) return failed("empty-diff", "The selected files have no changes.");
    const prompt = buildCommitMessagePrompt({ ...diff, recentSubjects: await this.readRecentSubjects(repoPath) });
    const completion = await this.completeWithin(prompt, repoPath, timeoutMs);
    if ("status" in completion) return completion;
    const message = parseCommitMessageResponse(completion.text);
    if (!message) return failed("unparseable", "The model did not return a usable commit message.");
    return {
      status: "ok",
      ...message,
      model: { provider: completion.provider, id: completion.model, name: this.modelName(completion) },
    };
  }

  private async completeWithin(prompt: string, cwd: string, timeoutMs: number): Promise<UtilityCompletion | Failed> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A completion that finishes after the timeout is dropped; the caller already has its answer.
    const timeout = new Promise<Failed>((resolve) => {
      timer = setTimeout(() => resolve(failed("timeout", `The model did not answer within ${timeoutMs / 1000}s.`)), timeoutMs);
    });
    try {
      return await Promise.race([this.completion.complete(prompt, cwd), timeout]);
    } catch (error) {
      if (isProviderAvailabilityError(error) || error instanceof NoCompletionProviderError) {
        return failed("provider-unavailable", error.message);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readRecentSubjects(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await this.gitExecutor.exec(
        ["-C", repoPath, "log", "-n", String(STYLE_SAMPLE_SIZE), "--format=%s"],
      );
      return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch (error) {
      // An unborn branch has no history to sample; `git log` exits non-zero there.
      if (gitExitCode(error) !== null) return [];
      throw error;
    }
  }

  private modelName(completion: UtilityCompletion): string {
    return this.models.getCached(completion.provider)?.find((model) => model.id === completion.model)?.name
      ?? completion.model;
  }
}

function failed(reason: Failed["reason"], message: string): Failed {
  return { status: "failed", reason, message };
}
