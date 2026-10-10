import "reflect-metadata";
import { describe, expect, it } from "vitest";
import * as agents from "../index.js";

describe("agents feature boundary", () => {
  it("exposes only the composition-root agent symbols", () => {
    expect(Object.keys(agents).sort()).toStrictEqual([
      "AgentService",
      "ApprovalService",
      "CanonicalAgentBoundary",
      "DelegationTargetResolver",
      "GoalLifecycleService",
      "ParentAssistantTextCheckpointService",
      "PlanTurnService",
      "SubagentLifecycleService",
      "TurnRecoveryService",
      "publishCanonicalAgentEvents",
      "startAgentOrchestration",
    ]);
  });
});
