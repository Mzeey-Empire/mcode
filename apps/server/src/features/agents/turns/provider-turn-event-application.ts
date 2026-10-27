import { inject, injectable } from "tsyringe";
import { AgentEventType, type AgentEvent } from "@mcode/contracts/events/agent-event";

import { broadcast } from "../../../application/transport/push.js";
import { TURN_FINALIZER, TurnFinalizer } from "./turn-finalizer.js";
import { ParentAssistantTextCheckpointService } from "./parent-assistant-text-checkpoint-service.js";
import { ParentAssistantTextCoordinator } from "./parent-assistant-text-coordinator.js";
import { PARENT_TURN_DURABILITY, type ParentTurnDurability } from "./parent-turn-durability.js";
import { TurnConversationProjectionService } from "./turn-conversation-projection-service.js";
import type { TurnEventApplication } from "./turn-event-pipeline.js";
import {
  TURN_RUNTIME_EVENT_CONTROL,
  type TurnRuntimeEventControl,
} from "../orchestration/turn-runtime-event-control.js";
import { AgentEventPublicationRegistry } from "../orchestration/agent-event-publication-registry.js";

/** Applies normalized provider events after the runtime controller admits them in pipeline order. */
@injectable()
export class ProviderTurnEventApplication implements TurnEventApplication {
  private readonly parentAssistantText: ParentAssistantTextCoordinator;

  constructor(
    @inject(TURN_FINALIZER) private readonly finalizer: TurnFinalizer,
    @inject(TurnConversationProjectionService)
    private readonly conversationProjection: TurnConversationProjectionService,
    @inject(PARENT_TURN_DURABILITY) parentDurability: ParentTurnDurability,
    @inject(ParentAssistantTextCheckpointService) checkpoints: ParentAssistantTextCheckpointService,
    @inject(TURN_RUNTIME_EVENT_CONTROL) private readonly runtime: TurnRuntimeEventControl,
    @inject(AgentEventPublicationRegistry)
    private readonly publication: AgentEventPublicationRegistry,
  ) {
    this.parentAssistantText = new ParentAssistantTextCoordinator(
      parentDurability,
      checkpoints,
      (update) => {
        broadcast("turn.savingStatus", update);
      },
    );
  }

  /** Publish an execution-writer event without repeating any turn persistence. */
  publishCommitted(event: AgentEvent): void {
    this.publish(event);
  }

  /** Stream the private restart-reliability prefix through the same durable text owner. */
  async streamReliabilityAssistantText(threadId: string): Promise<{ threadId: string; executionId: string; text: string }> {
    if (!this.publication.isBound()) {
      throw new Error("Agent event publication is unavailable for reliability streaming");
    }
    const executionId = this.runtime.beginReliabilityTurn(threadId);
    const text = "Durable assistant prefix for restart recovery.";
    try {
      await this.conversationProjection.startReliabilityTurn(threadId, executionId);
      const event: Extract<AgentEvent, { type: "textDelta" }> = {
        type: AgentEventType.TextDelta,
        threadId,
        turnExecutionId: executionId,
        delta: text,
        isFinalResponse: true,
      };
      if (!this.queueParentAssistantText(event, () => {
        this.finalizer.appendStreamingText(threadId, text);
        this.publication.publish(event);
      })) {
        throw new Error("Reliability assistant text could not be queued");
      }
      if (!await this.parentAssistantText.flush(executionId)) {
        throw new Error("Reliability assistant text could not be checkpointed");
      }
      return { threadId, executionId, text };
    } catch (error) {
      this.runtime.releaseReliabilityTurn(threadId);
      throw error;
    }
  }

  /** Continue an active response after the user accepts unrecoverable text. */
  continueWithoutSaving(executionId: string): void {
    if (!this.parentAssistantText.continueWithoutSaving(executionId)) {
      throw new Error("Unsaved continuation is unavailable for this execution");
    }
  }

  /** Return the saving status for active runtime snapshots. */
  savingStatus(executionId: string | null): import("@mcode/contracts/models/turn-runtime").TurnRuntimeSnapshot["savingStatus"] {
    return executionId ? this.parentAssistantText.durabilityMode(executionId) : null;
  }

  private publish(event: AgentEvent): void {
    this.publication.publish(event);
  }

  private queueParentAssistantText(
    event: Extract<AgentEvent, { type: "textDelta" }>,
    publish: () => void,
  ): boolean | "blocked" | undefined {
    return this.parentAssistantText.queueText(
      event,
      publish,
      (reason) => this.runtime.stopForEventApplicationFailure(event, reason),
    );
  }

  /** Drain accepted feature persistence after provider ingress has stopped. */
  async drainPersistence(): Promise<void> {
    await this.parentAssistantText.close();
  }
}
