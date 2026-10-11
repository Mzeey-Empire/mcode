import type { MessageMention, ProviderId, TurnSteerOutcome } from "@mcode/contracts";
import type { AcceptedSteerMessage } from "../canonical/canonical-accepted-progress.js";

/** One message for the turn a {@link SteerableTurn} names. The runtime fills in the session and turn. */
export interface TurnSteerMessage {
  readonly steerId: string;
  /** Text for the provider, with mentioned file contents already appended where the provider needs them. */
  readonly message: string;
  /** Validated mentions, for providers that read them natively. */
  readonly mentions?: readonly MessageMention[];
}

/** The turn a steer may join. `steer` is null when the thread's provider cannot steer. */
export interface SteerableTurn {
  readonly turnExecutionId: string;
  /** Where the turn's mentions resolve, as for `agent.send`. */
  readonly workspaceId: string;
  readonly providerId: ProviderId;
  readonly steer: ((input: TurnSteerMessage) => Promise<TurnSteerOutcome>) | null;
}

/** What steering needs from the turn runtime, without exposing the runtime itself. */
export interface TurnSteerRuntime {
  /** The thread's running turn, or null when none runs or it is stopping or finishing. */
  runningTurn(threadId: string): SteerableTurn | null;
  /** Append the delivered message to the running turn and mark its steer delivered in one save. */
  recordDelivered(message: AcceptedSteerMessage): Promise<void>;
}

/** Bound by the turn runtime during composition, so steering never holds the runtime controller. */
export class TurnSteerRuntimePort implements TurnSteerRuntime {
  private target: TurnSteerRuntime | undefined;

  /** Bind the single runtime owner during composition. */
  bind(target: TurnSteerRuntime): void {
    this.target = target;
  }

  /** The thread's running turn, or null when none runs. */
  runningTurn(threadId: string): SteerableTurn | null {
    return this.requireTarget().runningTurn(threadId);
  }

  /** Append the delivered message to the running turn. */
  recordDelivered(message: AcceptedSteerMessage): Promise<void> {
    return this.requireTarget().recordDelivered(message);
  }

  private requireTarget(): TurnSteerRuntime {
    if (!this.target) throw new Error("Turn steer runtime is not configured");
    return this.target;
  }
}
