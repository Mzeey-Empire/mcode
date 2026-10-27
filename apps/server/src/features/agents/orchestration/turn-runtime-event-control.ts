import type { AgentEvent } from "@mcode/contracts/events/agent-event";

/** Injection token for the runtime controls used by normalized provider-event application. */
export const TURN_RUNTIME_EVENT_CONTROL = "TurnRuntimeEventControl";

/** Runtime lifecycle operations required to apply normalized provider events. */
export interface TurnRuntimeEventControl {
  /** Stop the active provider after a durability or queue failure. */
  stopForEventApplicationFailure(event: AgentEvent, reason: string): void;
}
