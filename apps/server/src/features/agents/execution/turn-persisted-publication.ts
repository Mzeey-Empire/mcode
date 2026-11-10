import { broadcast } from "../../../application/transport/push.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import type { ExecutionTerminalPersistenceReceipt } from "./execution-worker-handler.js";
import type { TurnFileEvidenceLedger } from "./turn-file-evidence-ledger.js";

let fileEvidenceLedger: TurnFileEvidenceLedger | undefined;
/** Wire the shared committed and accepted terminal publisher to its evidence owner. */
export function bindTurnFileEvidenceLedger(ledger: TurnFileEvidenceLedger): void { fileEvidenceLedger = ledger; }

/**
 * Tell clients a turn's terminal state is on disk. Both the committed writer path and the
 * accepted save path call this once per finished execution, after the terminal write lands.
 */
export function publishTurnPersisted(execution: ExecutionIdentity, persisted: ExecutionTerminalPersistenceReceipt): void {
  try {
    broadcast("thread.status", { threadId: execution.threadId,
      status: persisted.outcome === "cancelled" ? "interrupted" : persisted.outcome });
    broadcast("turn.persisted", {
      threadId: execution.threadId,
      turnId: execution.turnId,
      messageId: persisted.messageId,
      settledMessage: persisted.settledMessage,
      toolCallCount: persisted.toolCallCount,
      outcome: persisted.outcome,
      executionId: execution.executionId,
    });
  } finally { fileEvidenceLedger?.terminalSaved(execution); }
}
