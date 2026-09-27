import type { AgentEvent } from "@mcode/contracts";

import type { DataOnlyParentTerminalProjectionInput } from "../canonical/canonical-parent-turn-write.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import { CodexLiveEventEffects, type CodexLiveRuntimeIntent } from "./codex-live-event-effects.js";
import { CodexLiveEventReducer, type CodexPlanFeature, type CodexLiveReduction, type SyntheticTerminalInput } from "./codex-live-event-reducer.js";
import type { ExecutionLivePublicationIntent, ParentLiveEffects } from "./execution-worker-handler.js";

/** Providers whose AgentEvents use the shared parent turn projection. */
export type OtherLiveProviderId = "claude" | "cursor";

/** Runtime work retained after the event and its parent effects are durable. */
export type OtherProviderRuntimeIntent = CodexLiveRuntimeIntent | {
  readonly kind: "assistant-message-feature";
  readonly providerId: OtherLiveProviderId;
  readonly event: Extract<AgentEvent, { type: "message" }>;
};

/** One execution-bound provider event prepared for a single semantic write. */
export type OtherProviderLivePreparation =
  | {
    readonly kind: "prepared";
    readonly providerId: OtherLiveProviderId;
    readonly execution: ExecutionIdentity;
    readonly effects: ParentLiveEffects;
    readonly publication: ExecutionLivePublicationIntent;
    readonly runtime: readonly OtherProviderRuntimeIntent[];
    readonly terminal?: DataOnlyParentTerminalProjectionInput;
  }
  | {
    readonly kind: "unsupported";
    readonly providerId: OtherLiveProviderId;
    readonly execution: ExecutionIdentity;
    readonly eventType: AgentEvent["type"];
    readonly reason: string;
  };

/**
 * Prepares Claude or Cursor parent writes from their normalized AgentEvents.
 * Keep one instance per execution and discard it after any failed writer commit.
 */
export class OtherProviderLiveEventEffects {
  private readonly reducer: CodexLiveEventReducer;
  private readonly effects: CodexLiveEventEffects;

  constructor(
    readonly providerId: OtherLiveProviderId,
    readonly execution: ExecutionIdentity,
    precedingMessageId: string,
    planFeature: CodexPlanFeature = "none",
  ) {
    this.reducer = new CodexLiveEventReducer(execution, planFeature);
    this.effects = new CodexLiveEventEffects(execution, precedingMessageId);
  }

  /** Reduce exactly one event; unsupported input never yields a publication. */
  prepare(event: AgentEvent, endedAt?: string): OtherProviderLivePreparation {
    if (event.type === "turnComplete" && event.providerId && event.providerId !== this.providerId) {
      return {
        kind: "unsupported",
        providerId: this.providerId,
        execution: this.execution,
        eventType: event.type,
        reason: "different provider",
      };
    }
    return this.prepareReduction(this.reducer.reduce(event), endedAt);
  }

  /** Prepare an interrupted execution from worker-owned buffers, including unclassified partial text. */
  finishFromState(input: SyntheticTerminalInput, endedAt?: string): OtherProviderLivePreparation {
    return this.prepareReduction(this.reducer.finishFromState(input), endedAt);
  }

  private prepareReduction(reduction: CodexLiveReduction, endedAt?: string): OtherProviderLivePreparation {
    if (reduction.kind === "unsupported") {
      return {
        kind: "unsupported",
        providerId: this.providerId,
        execution: this.execution,
        eventType: reduction.eventType,
        reason: reduction.reason,
      };
    }
    const prepared = this.effects.prepare(reduction, endedAt);
    const messageFeature = reduction.writer.find((intent) => intent.kind === "feature-event"
      && intent.feature === "assistant-message");
    const runtime: OtherProviderRuntimeIntent[] = [...prepared.runtime];
    if (messageFeature?.kind === "feature-event" && messageFeature.event.type === "message") {
      runtime.push({ kind: "assistant-message-feature", providerId: this.providerId, event: messageFeature.event });
    }
    return structuredClone({
      kind: "prepared",
      providerId: this.providerId,
      execution: this.execution,
      ...prepared,
      runtime,
    });
  }
}
