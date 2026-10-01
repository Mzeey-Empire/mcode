import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import type { AgentEvent, ProviderId } from "@mcode/contracts";

import {
  PARENT_TURN_DURABILITY,
  type ParentTurnDurability,
} from "./parent-turn-durability.js";
import {
  TURN_RUNTIME_PERSISTENCE,
  type TurnRuntimePersistence,
} from "./turn-runtime-persistence.js";

/** Persists provider-native session cursor updates with their durable provenance. */
@injectable()
export class ProviderSessionCursorPersistence {
  constructor(
    @inject(TURN_RUNTIME_PERSISTENCE) private readonly runtime: TurnRuntimePersistence,
    @inject(PARENT_TURN_DURABILITY) private readonly parentTurns: ParentTurnDurability,
  ) {}

  /** Apply a normalized provider system event when it carries session state. */
  async apply(providerId: ProviderId, event: Extract<AgentEvent, { type: "system" }>, executionId?: string): Promise<void> {
    if (event.subtype.startsWith("sdk_session_id:")) {
      await this.save(providerId, event.threadId, event.subtype.slice("sdk_session_id:".length), executionId);
      return;
    }
    if (event.subtype === "sdk_session_invalidated") await this.clear(event.threadId);
  }

  /** Remove a stale cursor before a retry starts a fresh provider session. */
  clearForRetry(threadId: string): Promise<void> {
    return this.clear(threadId);
  }

  private async save(providerId: ProviderId, threadId: string, cursor: string, executionId?: string): Promise<void> {
    if (!cursor) return;
    try {
      await this.runtime.saveProviderCursor(threadId, cursor);
      if (!executionId) return;
      await this.parentTurns.recordNativeCursor(executionId, {
        providerId,
        scope: nativeCursorScope(providerId),
        value: cursor,
        provenance: "native",
      });
    } catch (error) {
      logger.warn("Failed to persist provider session cursor", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async clear(threadId: string): Promise<void> {
    try {
      await this.runtime.clearProviderCursor(threadId);
    } catch (error) {
      logger.warn("Failed to clear provider session cursor", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function nativeCursorScope(providerId: ProviderId): "thread" | "session" {
  return providerId === "codex" ? "thread" : "session";
}
