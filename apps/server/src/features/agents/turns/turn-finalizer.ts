
import { AssistantExecutionState } from "./assistant-execution-state.js";

/** Injection token for the composed terminal materialization seam. */
export const TURN_FINALIZER = "TurnFinalizer";

/** Retains the assistant text buffered by the private restart-reliability stream. */
export class TurnFinalizer {
  /** One assistant decision state per active thread execution. */
  private readonly assistantStateByThread = new Map<string, AssistantExecutionState>();

  /** Append a streaming assistant-text delta for the current turn. */
  appendStreamingText(threadId: string, delta: string): void {
    this.assistantState(threadId).appendStreamingText(delta);
  }

  private assistantState(threadId: string): AssistantExecutionState {
    const state = this.assistantStateByThread.get(threadId) ?? new AssistantExecutionState();
    this.assistantStateByThread.set(threadId, state);
    return state;
  }
}
