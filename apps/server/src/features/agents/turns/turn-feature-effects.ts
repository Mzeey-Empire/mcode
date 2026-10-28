import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import { GoalLifecycleService } from "../goals/goal-lifecycle-service.js";
import { PlanTurnService } from "../planning/plan-turn-service.js";
import { SubagentRosterService } from "../collaboration/subagent-roster-service.js";

type AgentMessage = Extract<AgentEvent, { type: "message" }>;

/** Injection token for the explicitly composed feature-effect coordinator. */
export const TURN_FEATURE_EFFECTS = Symbol("TurnFeatureEffects");

/** Coordinates feature-owned reactions to normalized turn lifecycle events. */
export class TurnFeatureEffects {
  constructor(
    private readonly plans: PlanTurnService,
    private readonly goals: GoalLifecycleService,
    private readonly subagents: SubagentRosterService,
  ) {}

  /** Apply plan and goal reactions at an assistant-message boundary. */
  onAssistantMessage(providerId: ProviderId, event: AgentMessage): void {
    this.goals.onAssistantMessage(providerId, event);
  }

  /** Refresh goal state after the terminal turn reaches durable completion. */
  refreshAfterTurn(threadId: string): void {
    this.goals.refreshAfterTurn(threadId);
    this.subagents.turnFinished(threadId);
  }

  /** Notify the roster after narrative tool state has been applied. */
  subagentToolChanged(threadId: string, toolCallId: string): void {
    this.subagents.toolChanged(threadId, toolCallId);
  }

  /** Stop every descendant before the parent provider session is stopped. */
  stopDescendants(threadId: string): Promise<void> | void {
    return this.subagents.stopDescendants(threadId);
  }

  /** Acknowledge worker-owned plan persistence before terminal cleanup. */
  onPlanPersisted(threadId: string): void {
    this.plans.markPlanPersisted(threadId);
  }

  /** Clear feature-local turn state after terminal cleanup. */
  clearTurn(threadId: string): void {
    this.plans.clearTurn(threadId);
  }
}
