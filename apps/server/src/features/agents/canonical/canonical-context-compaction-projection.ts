import type { Database } from "bun:sqlite";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import type { ProjectedCommittedProviderEvent } from "../execution/execution-worker-handler.js";

/** Applies Codex context and compaction effects on the canonical writer connection. */
export class CanonicalContextCompactionProjection {
  private readonly threads: ThreadRepo;
  private readonly messages: MessageRepo;

  constructor(db: Database) {
    this.threads = new ThreadRepo(db);
    this.messages = new MessageRepo(db);
  }

  /** Return the compaction state after ordered events; null means an unsupported terminal arrived. */
  apply(threadId: string, compacting: boolean, events: readonly ProjectedCommittedProviderEvent[]): boolean | null {
    let active = compacting;
    for (const { providerId, event } of events) {
      if (providerId !== "codex") continue;
      const next = this.applyEvent(threadId, active, event);
      if (next === null) return null;
      active = next;
    }
    return active;
  }

  private applyEvent(threadId: string, active: boolean, event: ProjectedCommittedProviderEvent["event"]): boolean | null {
    switch (event.type) {
      case "contextEstimate":
        if (event.totalProcessedTokens !== undefined && !active) this.recordUsage(threadId, event.tokensIn, event.contextWindow);
        return active;
      case "turnComplete":
        if (active) return null;
        this.recordUsage(threadId, event.tokensIn, event.contextWindow);
        return active;
      case "compacting":
        if (!event.active) this.persistDivider(threadId);
        return event.active;
      case "compactSummary":
        this.threads.updateCompactSummary(threadId, event.summary);
        return false;
      default: return active;
    }
  }

  private recordUsage(threadId: string, tokensIn: number, contextWindow?: number): void {
    if (tokensIn > 0) this.threads.updateContextUsage(threadId, tokensIn, contextWindow);
  }

  private persistDivider(threadId: string): void {
    const sequence = this.messages.getLatestSequenceIncludingInternal(threadId) + 1;
    this.messages.create(threadId, "system", "Context compacted", sequence);
  }
}
