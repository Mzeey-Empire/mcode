import { type CanonicalChildRoster, type CanonicalChildRosterRequest } from "../canonical/canonical-child-roster.js";
import type {
  CanonicalSubagentStopRequest,
} from "@mcode/contracts";

/** Injection token for durable sub-agent lifecycle state. */
export const SUBAGENT_LIFECYCLE_DURABILITY = Symbol("SubagentLifecycleDurability");

/** Provider-native identity and durable status required to stop one sub-agent turn. */
export interface SubagentStopTarget {
  childThread: { id: string; providerId: string };
  latestTurn: { status: string } | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
}

/** Narrow durable state needed by sub-agent roster and stop operations. */
export interface SubagentLifecycleDurability {
  loadSubagentRoster(request: CanonicalChildRosterRequest): CanonicalChildRoster;
  loadSubagentStopTarget(request: CanonicalSubagentStopRequest): SubagentStopTarget | null;
  loadActiveSubagentStopTargets(owningParentThreadId: string): SubagentStopTarget[];
  interruptSubagentTurns(childThreadIds: readonly string[], reason: string): Promise<void>;
  finishSubagentTurn(input: {
    childThreadId: string;
    nativeTurnId: string;
    outcome: "interrupted";
    error: string;
  }): Promise<{ status: string }>;
}
