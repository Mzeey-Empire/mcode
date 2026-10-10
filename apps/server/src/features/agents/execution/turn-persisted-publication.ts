import { broadcast } from "../../../application/transport/push.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import type { ExecutionTerminalPersistenceReceipt } from "./execution-worker-handler.js";

/**
 * Tell clients a turn's terminal state is on disk. Both the committed writer path and the
 * accepted save path call this once per finished execution, after the terminal write lands.
 */
export function publishTurnPersisted(execution: ExecutionIdentity, persisted: ExecutionTerminalPersistenceReceipt): void {
  broadcast("thread.status", { threadId: execution.threadId,
    status: persisted.outcome === "cancelled" ? "interrupted" : persisted.outcome });
  broadcast("turn.persisted", {
    threadId: execution.threadId,
    turnId: execution.turnId,
    messageId: persisted.messageId,
    settledMessage: persisted.settledMessage,
    toolCallCount: persisted.toolCallCount,
    filesChanged: [...persisted.filesChanged],
    outcome: persisted.outcome,
    executionId: execution.executionId,
    ...(persisted.fileEffects ? { fileEffects: persisted.fileEffects } : {}),
  });
}
