/** Agent orchestration service used by the server composition roots. */
export { AgentService } from "./orchestration/agent-service.js";

/** Agent permission capability used by the server composition roots. */
export { ApprovalService } from "./approvals/approval-service.js";

/** Owns plan questions and captured plan versions. */
export { PlanTurnService } from "./planning/plan-turn-service.js";

/** Owns provider-native goal lifecycle and goal commands. */
export { GoalLifecycleService } from "./goals/goal-lifecycle-service.js";

/** Owns sub-agent roster and stop operations. */
export { SubagentRosterService } from "./collaboration/subagent-roster-service.js";

/** Full canonical agent system boundary used by the server composition roots. */
export { CanonicalAgentBoundary } from "./canonical/canonical-agent-boundary.js";

/** Publishes canonical agent events for the server composition roots. */
export { publishCanonicalAgentEvents } from "./canonical/canonical-agent-boundary.js";

/** Reconciles unfinished agent turns after a server restart. */
export { TurnRecoveryService } from "./recovery/turn-recovery-service.js";

/** Persists temporary durable text for unfinished parent assistant responses. */
export { ParentAssistantTextCheckpointService } from "./turns/parent-assistant-text-checkpoint-service.js";

/** Starts agent execution and normalized provider-event publication. */
export { startAgentOrchestration } from "./orchestration/start-agent-orchestration.js";

/** Resolves provider/model targets for delegated thread creation. */
export { DelegationTargetResolver } from "./collaboration/delegation-target-resolver.js";
