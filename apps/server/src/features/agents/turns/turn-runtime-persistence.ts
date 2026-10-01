import { inject, injectable } from "tsyringe";
import type { Thread } from "@mcode/contracts";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";

/** Persisted state the runtime needs to control one active provider session. */
export type TurnRuntimePersistenceState = Pick<Thread, "provider" | "status">;

/** Persisted thread state required by the runtime owner without exposing repository access. */
export interface TurnRuntimePersistence {
  /** Load the provider, status, and cursor state for one runtime decision. */
  load(threadId: string): TurnRuntimePersistenceState | null;
  /** Store context usage reported by a provider turn. */
  recordContextUsage(threadId: string, tokens: number, contextWindow?: number): Promise<void>;
  /** Store a provider-produced compaction summary. */
  recordCompactionSummary(threadId: string, summary: string): Promise<void>;
  /** Store a provider cursor that can resume a later turn. */
  saveProviderCursor(threadId: string, cursor: string): Promise<void>;
  /** Remove a cursor that the provider has invalidated. */
  clearProviderCursor(threadId: string): Promise<void>;
  /** Store a terminal lifecycle state selected by the runtime owner. */
  setRuntimeStatus(threadId: string, status: "paused" | "interrupted"): Promise<void>;
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

  async recordContextUsage(threadId: string, tokens: number, contextWindow?: number): Promise<void> {
    await this.threads.updateContextUsage(threadId, tokens, contextWindow);
  }

  recordCompactionSummary(threadId: string, summary: string): Promise<void> {
    return this.threads.updateCompactSummary(threadId, summary);
  }

  async saveProviderCursor(threadId: string, cursor: string): Promise<void> {
    await this.threads.updateSdkSessionId(threadId, cursor);
  }

  async clearProviderCursor(threadId: string): Promise<void> {
    await this.threads.clearSdkSessionId(threadId);
  }

  async setRuntimeStatus(threadId: string, status: "paused" | "interrupted"): Promise<void> {
    await this.threads.updateStatus(threadId, status);
  }
}
