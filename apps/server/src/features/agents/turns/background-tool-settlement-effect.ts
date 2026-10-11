import { inject, injectable } from "tsyringe";
import type { ProviderBackgroundToolSettlement } from "@mcode/providers";
import { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import { TURN_FEATURE_EFFECTS, type TurnFeatureEffects } from "./turn-feature-effects.js";

/** The summary a background call gets when the provider that ran it did not survive a restart. */
export const ORPHANED_BACKGROUND_TOOL_OUTPUT = "Stopped when Mcode restarted.";

/** Settles background tool calls against the finished turn that launched them. */
@injectable()
export class BackgroundToolSettlementEffect {
  private acceptedProgress: Pick<CanonicalAcceptedProgress, "acceptLateToolResult" | "waitForSaved"> | undefined;

  constructor(
    @inject(CanonicalAgentBoundary) private readonly canonical: Pick<CanonicalAgentBoundary, "listHeldBackgroundToolCalls">,
    @inject(TURN_FEATURE_EFFECTS) private readonly featureEffects: Pick<TurnFeatureEffects, "subagentToolChanged">,
  ) {}

  /** Compose accepted admission independently of the terminal save acknowledgement. */
  bindAcceptedProgress(progress: NonNullable<BackgroundToolSettlementEffect["acceptedProgress"]>): void {
    this.acceptedProgress = progress;
  }

  /** Admit the late result immediately against its launching execution. */
  settle(settlement: ProviderBackgroundToolSettlement): void {
    const progress = this.progress();
    const { threadId, executionId, toolCallId, status, output } = settlement;
    progress.acceptLateToolResult(threadId, executionId, { toolCallId, status, output });
    this.featureEffects.subagentToolChanged(threadId, toolCallId);
  }

  /**
   * Stop every background call still held after a restart. No provider process survives
   * one, so no late result can arrive for these calls.
   */
  async settleOrphansAtStartup(): Promise<number> {
    const progress = this.progress();
    const held = this.canonical.listHeldBackgroundToolCalls();
    for (const [index, call] of held.entries()) {
      this.settle({ ...call, status: "cancelled", output: ORPHANED_BACKGROUND_TOOL_OUTPUT });
      // Accepted progress keeps only a few threads in memory, so each thread's writes
      // must land before the sweep moves on to the next one.
      if (held[index + 1]?.threadId !== call.threadId) await progress.waitForSaved(call.threadId);
    }
    return held.length;
  }

  private progress(): NonNullable<BackgroundToolSettlementEffect["acceptedProgress"]> {
    if (!this.acceptedProgress) throw new Error("Background tool settlement requires accepted progress composition");
    return this.acceptedProgress;
  }
}
