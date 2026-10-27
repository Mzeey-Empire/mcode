import type { CanonicalAgentEventEnvelope } from "@mcode/contracts/compat/agent-model";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import type { TurnResumeMode } from "@mcode/contracts/models/turn-recovery";
import { SESSION_RESUME_UNAVAILABLE_CODE } from "@mcode/providers";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";

/** Hidden user turn that asks the agent to pick up where the interrupted turn stopped. */
export const RESUME_CONTINUATION_PROMPT =
  "The previous turn was interrupted before it finished. Continue the task. Check the working tree before repeating a step.";

/** Facts that decide whether the provider can continue its own session or needs a seeded fresh one. */
export interface ResumePathInput {
  readonly supportsSessionResume: boolean;
  readonly sdkSessionId: string | null;
  readonly threadProvider: ProviderId;
  /** Provider that ran the interrupted turn; null when the thread record does not name one. */
  readonly turnProvider: string | null;
}

/**
 * Continue natively only when the thread's provider can resume, holds a native session id, and is the provider
 * that ran the interrupted turn. A provider switch leaves the stored session belonging to someone else.
 */
export function chooseResumePath(input: ResumePathInput): TurnResumeMode {
  const canContinueNatively = input.supportsSessionResume
    && input.sdkSessionId !== null
    && input.sdkSessionId !== ""
    && input.turnProvider === input.threadProvider;
  return canContinueNatively ? "native-session" : "seeded-session";
}

/**
 * Watches one native resume attempt through committed canonical events. `started` resolves when the provider
 * accepts the attempt. `resumeUnavailable` turns true when the attempt errors because the provider could not
 * continue its stored session, which is the only ending that triggers the seeded fallback.
 */
export class NativeResumeWatch {
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private unavailable = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly turnId: string) {
    this.started = new Promise((resolve) => { this.resolveStarted = resolve; });
    this.unsubscribe = subscribeCommittedCanonicalEvents((events) => this.observe(events));
  }

  /** True once the attempt ended because its native session could not be resumed. */
  get resumeUnavailable(): boolean {
    return this.unavailable;
  }

  /** Stop observing. Safe to call more than once. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private observe(events: readonly CanonicalAgentEventEnvelope[]): void {
    for (const event of events) {
      if (event.routing.turnId !== this.turnId) continue;
      const payload = event.payload;
      if (payload.type === "turn.provider-started") this.resolveStarted();
      if (payload.type === "turn.errored" && payload.failure?.code === SESSION_RESUME_UNAVAILABLE_CODE) {
        this.unavailable = true;
      }
    }
  }
}
