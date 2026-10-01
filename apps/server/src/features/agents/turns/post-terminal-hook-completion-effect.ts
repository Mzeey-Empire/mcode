import { injectable } from "tsyringe";
import type { CreateHookExecutionInput } from "../events/persistence/hook-execution-repo.js";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";

/** Correlates external late hooks with their original turn before another turn can replace it. */
@injectable()
export class PostTerminalHookCompletionEffect {
  private acceptedProgress: Pick<CanonicalAcceptedProgress, "acceptLateHook"> | undefined;

  /** Compose accepted hook admission independently of the terminal save acknowledgement. */
  bindAcceptedProgress(progress: NonNullable<PostTerminalHookCompletionEffect["acceptedProgress"]>): void {
    this.acceptedProgress = progress;
  }
  /** Admit the captured hook immediately against its original execution and stable hook identity. */
  schedule(threadId: string, hook: Omit<CreateHookExecutionInput, "messageId">, executionId: string): void {
    if (!this.acceptedProgress) throw new Error("Late hook completion requires accepted progress composition");
    if (!executionId) throw new Error("Late hook completion lacks its original execution identity");
    this.acceptedProgress.acceptLateHook(threadId, executionId, hook);
  }
}
