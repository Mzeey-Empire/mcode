import type { Database } from "bun:sqlite";
import type { CanonicalAgentEventEnvelope } from "@mcode/contracts";
import { databaseWriteHandler, type DatabaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { CanonicalAgentStore } from "./canonical-agent-store.js";
import { CanonicalParentTurnWrite } from "./canonical-parent-turn-write.js";
import { canonicalRuntimeWriteOperations } from "./canonical-runtime-write-operations.js";

/** Construct main runtime operations with publication data retained until the outer commit. */
export function canonicalRuntimeWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const publications: CanonicalAgentEventEnvelope[] = [];
  const publish = (events: readonly CanonicalAgentEventEnvelope[]) => publications.push(...events);
  const canonical = new CanonicalAgentStore(db, publish);
  const parents = new CanonicalParentTurnWrite(db, publish);
  const operations = canonicalRuntimeWriteOperations;
  function entry<Input, Output>(operation: DatabaseWriteOperation<Input, { result: Output; events: CanonicalAgentEventEnvelope[] }>,
    apply: (input: Input) => Output): [string, (input: unknown) => unknown] {
    return [operation.name, databaseWriteHandler(operation, (input) => {
      publications.length = 0;
      const result = apply(input);
      return { result, events: [...publications] };
    })];
  }
  return new Map([
    entry(operations.parentFinishBatch, ({ input, endedAt, cursor }) => parents.finishBatch(input, endedAt, cursor)),
    entry(operations.parentStart, (input) => parents.start(input)),
    entry(operations.interruptLostExecution, (input) => parents.interruptLostExecution(input)),
    entry(operations.reopenUnmaterializedTerminalCheckpoint, (input) => canonical.reopenUnmaterializedTerminalCheckpoint(...input)),
    entry(operations.recordNativeCursor, (input) => canonical.recordNativeCursor(...input)),
    entry(operations.interruptSavedFamilyChildren, (input) => canonical.interruptSavedFamilyChildren(...input)),
    entry(operations.interruptSubagentTurns, (input) => { canonical.interruptSubagentTurns(...input); return true; }),
    entry(operations.finishSubagentTurn, (input) => canonical.finishSubagentTurn(input)),
    entry(operations.recordCollaborationAction, (input) => canonical.recordCollaborationAction(input)),
    entry(operations.startCodexChildDelegation, (input) => canonical.startCodexChildDelegation(input)),
    entry(operations.markCodexChildDeliveryUnknown, (input) => canonical.markCodexChildDeliveryUnknown(input)),
    entry(operations.markCodexChildDeliveryRejected, (input) => canonical.markCodexChildDeliveryRejected(input)),
    entry(operations.markUnresolvedCodexChildDeliveriesUnknown, (input) => canonical.markUnresolvedCodexChildDeliveriesUnknown(...input)),
    entry(operations.retryCodexChildDelegation, (input) => canonical.retryCodexChildDelegation(input)),
    entry(operations.registerCodexReceiverThreadIds, (input) => canonical.registerCodexReceiverThreadIds(input)),
    entry(operations.bindCodexChildIdentity, (input) => canonical.bindCodexChildIdentity(input)),
    entry(operations.startCodexChildTurn, (input) => canonical.startCodexChildTurn(input)),
    entry(operations.recordCodexChildItem, (input) => canonical.recordCodexChildItem(input)),
    entry(operations.finishCodexChildTurn, (input) => canonical.finishCodexChildTurn(input)),
    entry(operations.finishCanonicalChildTurn, (input) => canonical.finishCanonicalChildTurn(input)),
    entry(operations.recordCodexChildRoutingDiagnostic, (input) => canonical.recordCodexChildRoutingDiagnostic({ ...input, event: input.event })),
  ]);
}
