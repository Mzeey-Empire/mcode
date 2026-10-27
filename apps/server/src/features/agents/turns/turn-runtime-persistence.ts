import { inject, injectable } from "tsyringe";
import type { Thread } from "@mcode/contracts/models/thread";
import type { TurnOutcome } from "@mcode/contracts/models/turn-outcome";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";

/** Persisted state the runtime needs to control one active provider session. */
export type TurnRuntimePersistenceState = Pick<Thread, "provider" | "status">;

/** Persisted thread state required by the runtime owner without exposing repository access. */
export interface TurnRuntimePersistence {
  /** Load the provider, status, and cursor state for one runtime decision. */
  load(threadId: string): TurnRuntimePersistenceState | null;
  /** Store a terminal lifecycle state selected by the runtime owner. */
  setRuntimeStatus(threadId: string, status: "paused" | "interrupted"): Promise<void>;
  /** Record the real terminal outcome before applying the legacy runtime status. */
  recordTurnOutcome(threadId: string, outcome: TurnOutcome): Promise<void>;
}

/** Injection token for the runtime persistence port. */
export const TURN_RUNTIME_PERSISTENCE = "TurnRuntimePersistence";

/** Implements runtime persistence with the thread feature's durable store. */
@injectable()
export class ThreadRuntimePersistence implements TurnRuntimePersistence {
  constructor(@inject(ThreadRepo) private readonly threads: ThreadRepo) {}

  load(threadId: string): TurnRuntimePersistenceState | null {
    return this.threads.findById(threadId);
  }

  async setRuntimeStatus(threadId: string, status: "paused" | "interrupted"): Promise<void> {
    await this.threads.updateStatus(threadId, status);
  }

  async recordTurnOutcome(threadId: string, outcome: TurnOutcome): Promise<void> {
    await this.threads.recordTurnOutcome(threadId, outcome, new Date().toISOString());
  }
}
