import type { Database } from "bun:sqlite";
import * as NodeCrypto from "node:crypto";
import { inject, injectable } from "tsyringe";
import type { AcceptedCanonicalAgentEventEnvelope } from "@mcode/contracts";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import type { DatabaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { CanonicalAgentWriterClient } from "./canonical-agent-writer-client.js";
import { CanonicalAgentStore, publishCanonicalAgentEvents, type CanonicalAgentEventPublisher } from "./canonical-agent-store.js";
import { canonicalRuntimeWriteOperations } from "./canonical-runtime-write-operations.js";
import { ConversationDisplayMaterializer } from "../conversation/migrations/conversation-display-materializer.js";
import type { CanonicalProviderWriteInput } from "./canonical-agent-writer-protocol.js";
import type { DataOnlyParentTurnStartInput, DataOnlyParentTurnFinishInput, LostParentExecutionInput } from "./canonical-parent-turn-write.js";

export * from "./canonical-agent-store.js";

/** Main canonical reads and process diagnostics, with every durable mutation owned by the writer. */
@injectable()
export class CanonicalAgentBoundary {
  private readonly reader: CanonicalAgentStore;
  private acceptedSynthesizedPublication: ((threadId: string, events: readonly Record<string, unknown>[]) => readonly AcceptedCanonicalAgentEventEnvelope[]) | undefined;
  constructor(@inject("Database") db: Database,
    @inject(ApplicationDatabaseWriter) private readonly writer: ApplicationDatabaseWriter,
    @inject(CanonicalAgentWriterClient) private readonly canonicalWriter: CanonicalAgentWriterClient,
    @inject("CanonicalAgentEventPublisher") private readonly publish: CanonicalAgentEventPublisher = publishCanonicalAgentEvents) {
    this.reader = new CanonicalAgentStore(db, publish);
  }

  /** Install the accepted owner before synthesized observations are admitted. */
  bindAcceptedSynthesizedPublications(accept: NonNullable<CanonicalAgentBoundary["acceptedSynthesizedPublication"]>): void {
    this.acceptedSynthesizedPublication = accept;
  }

  /** Publish accepted synthesized progress without awaiting its retained save. */
  recordSynthesizedPublications(threadId: string, events: readonly Record<string, unknown>[]): readonly AcceptedCanonicalAgentEventEnvelope[] {
    if (events.length === 0) return [];
    if (!this.acceptedSynthesizedPublication) throw new Error("Synthesized progress has no accepted owner");
    return this.acceptedSynthesizedPublication(threadId, events);
  }

  /** Preserve canonical receipt replay and publish the returned committed envelopes. */
  async commit(input: CanonicalProviderWriteInput) {
    const operationId = "main-canonical:projected:" + NodeCrypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const result = await this.canonicalWriter.commitProjected(operationId, input);
    this.publishCommittedGroups(result.providerProjection.publications);
    await this.canonicalWriter.acknowledgeOperation(input.executionId, operationId);
    return result;
  }

  /** Persist recovery through its existing durable receipt protocol. */
  async recordParentNarrativeRecovery(input: Parameters<CanonicalAgentStore["recordParentNarrativeRecovery"]>[0]): Promise<boolean> {
    const operationId = "main-recovery:" + NodeCrypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const result = await this.canonicalWriter.recordParentNarrativeRecovery(operationId, input);
    await this.canonicalWriter.acknowledgeOperation(input.executionId, operationId);
    return result.recorded;
  }

  /** Classify recovered narrative and reset its provisional text with one replayable writer receipt. */
  async classifyParentNarrativeRecovery(input: Parameters<CanonicalAgentStore["recordParentNarrativeRecovery"]>[0], operationId: string) {
    const receipt = await this.canonicalWriter.classifyParentNarrativeRecovery(operationId, input);
    await this.canonicalWriter.acknowledgeOperation(input.executionId, operationId);
    return receipt;
  }

  /** Commit user-message and lifecycle data together without caller callbacks. */
  async startParentTurn(input: DataOnlyParentTurnStartInput) {
    return this.mutate(canonicalRuntimeWriteOperations.parentStart, input);
  }

  /** Confirm each bounded terminal checkpoint before submitting the next one. */
  async finishParentTurnBatched(input: DataOnlyParentTurnFinishInput) {
    const endedAt = new Date().toISOString();
    let cursor = 0;
    const writeBatches = { batches: 0, rows: 0, bytes: 0 };
    const events: import("@mcode/contracts").CanonicalAgentEventEnvelope[] = [];
    while (true) {
      const batch = await this.mutate(canonicalRuntimeWriteOperations.parentFinishBatch, { input, endedAt, cursor });
      writeBatches.batches += batch.result.writeBatches.batches;
      writeBatches.rows += batch.result.writeBatches.rows;
      writeBatches.bytes += batch.result.writeBatches.bytes;
      events.push(...batch.result.events);
      if (batch.completed) return { ...batch.result, events, writeBatches };
      if (batch.cursor <= cursor) throw new Error("Canonical terminal checkpoint did not advance");
      cursor = batch.cursor;
    }
  }

  /** Reconstruct and terminalize one lost execution on the writer's connection. */
  async interruptUnfinishedExecution(input: LostParentExecutionInput) {
    return this.mutate(canonicalRuntimeWriteOperations.interruptLostExecution, input);
  }

  /** Await all bounded display checkpoints before provider recovery reads their projections. */
  materializeConversationDisplay(): Promise<void> {
    return new ConversationDisplayMaterializer(this.writer).runToCompletion();
  }

  private async mutate<Input, Output>(operation: DatabaseWriteOperation<Input, {
    result: Output; events: import("@mcode/contracts").CanonicalAgentEventEnvelope[];
  }>, input: Input): Promise<Output> {
    const completed = await this.writer.execute(operation, input);
    this.publishCommittedGroups(completed.events);
    return completed.result;
  }

  private publishCommittedGroups(events: readonly import("@mcode/contracts").CanonicalAgentEventEnvelope[]): void {
    let start = 0;
    while (start < events.length) {
      const threadId = events[start]!.routing.threadId;
      let end = start + 1;
      while (end < events.length && end - start < 64 && events[end]!.routing.threadId === threadId) end += 1;
      this.publish(events.slice(start, end));
      start = end;
    }
  }

  /** Read an existing legacy thread for first accepted admission diagnostics without writing a canonical row. */
  loadThreadForAcceptance(...args: Parameters<CanonicalAgentStore["loadThreadForAcceptance"]>): ReturnType<CanonicalAgentStore["loadThreadForAcceptance"]> {
    return this.reader.loadThreadForAcceptance(...args);
  }

  /** Seed feature read-through once from saved legacy projections; new identities remain acceptance-owned. */
  loadAcceptedFeatureSeed(...args: Parameters<CanonicalAgentStore["loadAcceptedFeatureSeed"]>): ReturnType<CanonicalAgentStore["loadAcceptedFeatureSeed"]> {
    return this.reader.loadAcceptedFeatureSeed(...args);
  }

  /** Start raw capture for one turn after explicit consent. */
  startRawTurnCapture(...args: Parameters<CanonicalAgentStore["startRawTurnCapture"]>): ReturnType<CanonicalAgentStore["startRawTurnCapture"]> {
    return this.reader.startRawTurnCapture(...args);
  }

  /** Record one provider event in the bounded diagnostic service. */
  recordProviderDiagnostic(...args: Parameters<CanonicalAgentStore["recordProviderDiagnostic"]>): ReturnType<CanonicalAgentStore["recordProviderDiagnostic"]> {
    return this.reader.recordProviderDiagnostic(...args);
  }

  /** Export bounded diagnostics, with separate confirmation for raw content. */
  exportTurnDiagnostics(...args: Parameters<CanonicalAgentStore["exportTurnDiagnostics"]>): ReturnType<CanonicalAgentStore["exportTurnDiagnostics"]> {
    return this.reader.exportTurnDiagnostics(...args);
  }

  /** Load one canonical thread record. */
  loadThread(...args: Parameters<CanonicalAgentStore["loadThread"]>): ReturnType<CanonicalAgentStore["loadThread"]> {
    return this.reader.loadThread(...args);
  }

  /** Load the unique canonical thread carrying one exact provider identity. */
  loadThreadByProviderIdentity(...args: Parameters<CanonicalAgentStore["loadThreadByProviderIdentity"]>): ReturnType<CanonicalAgentStore["loadThreadByProviderIdentity"]> {
    return this.reader.loadThreadByProviderIdentity(...args);
  }

  /** Restore one renderer replica from contiguous durable events or a canonical snapshot. */
  recoverThread(...args: Parameters<CanonicalAgentStore["recoverThread"]>): ReturnType<CanonicalAgentStore["recoverThread"]> {
    return this.reader.recoverThread(...args);
  }

  /** Read the actual saved stream head when a live owner must be rehydrated. */
  savedProgressPosition(...args: Parameters<CanonicalAgentStore["savedProgressPosition"]>): ReturnType<CanonicalAgentStore["savedProgressPosition"]> {
    return this.reader.savedProgressPosition(...args);
  }

  /** Certify the saved watermark of an older generation even after later starts or startup recovery. */
  savedProgressThrough(...args: Parameters<CanonicalAgentStore["savedProgressThrough"]>): ReturnType<CanonicalAgentStore["savedProgressThrough"]> {
    return this.reader.savedProgressThrough(...args);
  }

  /** Hydrate complete already-saved parent history on the writer, without volatile-retention caps. */
  loadParentNarrativeForBinding(...args: Parameters<CanonicalAgentStore["loadParentNarrativeForBinding"]>): ReturnType<CanonicalAgentStore["loadParentNarrativeForBinding"]> {
    return this.reader.loadParentNarrativeForBinding(...args);
  }

  /** Load one canonical turn record. */
  loadTurn(...args: Parameters<CanonicalAgentStore["loadTurn"]>): ReturnType<CanonicalAgentStore["loadTurn"]> {
    return this.reader.loadTurn(...args);
  }

  /** Load the canonical turn bound to one Mcode execution identity. */
  loadTurnByExecution(...args: Parameters<CanonicalAgentStore["loadTurnByExecution"]>): ReturnType<CanonicalAgentStore["loadTurnByExecution"]> {
    return this.reader.loadTurnByExecution(...args);
  }

  /** Load the accepted user anchor owned by the exact parent execution. */
  loadParentTurnUserMessage(executionId: string): ReturnType<CanonicalAgentStore["loadParentTurnUserMessage"]> {
    return this.reader.loadParentTurnUserMessage(executionId);
  }

  /** Load the unique canonical turn carrying one exact provider identity. */
  loadTurnByProviderIdentity(...args: Parameters<CanonicalAgentStore["loadTurnByProviderIdentity"]>): ReturnType<CanonicalAgentStore["loadTurnByProviderIdentity"]> {
    return this.reader.loadTurnByProviderIdentity(...args);
  }

  /** Load the newest canonical turn for one thread. */
  loadLatestTurn(...args: Parameters<CanonicalAgentStore["loadLatestTurn"]>): ReturnType<CanonicalAgentStore["loadLatestTurn"]> {
    return this.reader.loadLatestTurn(...args);
  }

  /** Load one durable ingest checkpoint. */
  loadCheckpoint(...args: Parameters<CanonicalAgentStore["loadCheckpoint"]>): ReturnType<CanonicalAgentStore["loadCheckpoint"]> {
    return this.reader.loadCheckpoint(...args);
  }

  /** Load checkpoints whose canonical turn has no terminal outcome. */
  listUnfinishedCheckpoints(...args: Parameters<CanonicalAgentStore["listUnfinishedCheckpoints"]>): ReturnType<CanonicalAgentStore["listUnfinishedCheckpoints"]> {
    return this.reader.listUnfinishedCheckpoints(...args);
  }

  /** List terminal checkpoints that can be reopened because their terminal commit lacks a projection. */
  listUnmaterializedTerminalCheckpoints(...args: Parameters<CanonicalAgentStore["listUnmaterializedTerminalCheckpoints"]>): ReturnType<CanonicalAgentStore["listUnmaterializedTerminalCheckpoints"]> {
    return this.reader.listUnmaterializedTerminalCheckpoints(...args);
  }

  /** Load the visible entries for one restart-scoped recovery incident. */
  listRecoveryIncidentEntries(...args: Parameters<CanonicalAgentStore["listRecoveryIncidentEntries"]>): ReturnType<CanonicalAgentStore["listRecoveryIncidentEntries"]> {
    return this.reader.listRecoveryIncidentEntries(...args);
  }

  /** Load interrupted checkpoints that permit an explicit recovery action. */
  listInterruptedCheckpoints(...args: Parameters<CanonicalAgentStore["listInterruptedCheckpoints"]>): ReturnType<CanonicalAgentStore["listInterruptedCheckpoints"]> {
    return this.reader.listInterruptedCheckpoints(...args);
  }

  /** Load the canonical assistant projection needed to replay terminal post-commit effects. */
  loadTerminalProjection(...args: Parameters<CanonicalAgentStore["loadTerminalProjection"]>): ReturnType<CanonicalAgentStore["loadTerminalProjection"]> {
    return this.reader.loadTerminalProjection(...args);
  }

  /** Load one canonical semantic item. */
  loadItem(...args: Parameters<CanonicalAgentStore["loadItem"]>): ReturnType<CanonicalAgentStore["loadItem"]> {
    return this.reader.loadItem(...args);
  }

  /** Load the one Codex child delegation sourced by a canonical parent item. */
  loadCodexChildDelegation(...args: Parameters<CanonicalAgentStore["loadCodexChildDelegation"]>): ReturnType<CanonicalAgentStore["loadCodexChildDelegation"]> {
    return this.reader.loadCodexChildDelegation(...args);
  }

  /** Load the one Codex child delegation registered for an exact native receiver thread. */
  loadCodexChildDelegationByReceiverThreadId(...args: Parameters<CanonicalAgentStore["loadCodexChildDelegationByReceiverThreadId"]>): ReturnType<CanonicalAgentStore["loadCodexChildDelegationByReceiverThreadId"]> {
    return this.reader.loadCodexChildDelegationByReceiverThreadId(...args);
  }

  /** Load one canonical collaboration action. */
  loadCollaborationAction(...args: Parameters<CanonicalAgentStore["loadCollaborationAction"]>): ReturnType<CanonicalAgentStore["loadCollaborationAction"]> {
    return this.reader.loadCollaborationAction(...args);
  }

  /** Load the unique collaboration action for one canonical source and native item identity. */
  loadCollaborationActionBySourceProviderIdentity(...args: Parameters<CanonicalAgentStore["loadCollaborationActionBySourceProviderIdentity"]>): ReturnType<CanonicalAgentStore["loadCollaborationActionBySourceProviderIdentity"]> {
    return this.reader.loadCollaborationActionBySourceProviderIdentity(...args);
  }

  /** Read one owning parent's unique canonical descendant roster. */
  loadSubagentRoster(...args: Parameters<CanonicalAgentStore["loadSubagentRoster"]>): ReturnType<CanonicalAgentStore["loadSubagentRoster"]> {
    return this.reader.loadSubagentRoster(...args);
  }

  /** Project the saved roster's metadata rules from accepted family records without storage. */
  projectAcceptedSubagentRoster(...args: Parameters<CanonicalAgentStore["projectAcceptedSubagentRoster"]>): ReturnType<CanonicalAgentStore["projectAcceptedSubagentRoster"]> {
    return this.reader.projectAcceptedSubagentRoster(...args);
  }

  /** Resolve one owned child and its latest native identities without mutating canonical state. */
  loadCanonicalChildStopTarget(...args: Parameters<CanonicalAgentStore["loadCanonicalChildStopTarget"]>): ReturnType<CanonicalAgentStore["loadCanonicalChildStopTarget"]> {
    return this.reader.loadCanonicalChildStopTarget(...args);
  }

  /** Load bounded active descendants so parent stop can evaluate each target independently. */
  loadCanonicalChildStopTargets(...args: Parameters<CanonicalAgentStore["loadCanonicalChildStopTargets"]>): ReturnType<CanonicalAgentStore["loadCanonicalChildStopTargets"]> {
    return this.reader.loadCanonicalChildStopTargets(...args);
  }

  /** Load one sub-agent stop target through the generic lifecycle durability port. */
  loadSubagentStopTarget(...args: Parameters<CanonicalAgentStore["loadSubagentStopTarget"]>): ReturnType<CanonicalAgentStore["loadSubagentStopTarget"]> {
    return this.reader.loadSubagentStopTarget(...args);
  }

  /** Load active sub-agent stop targets through the generic lifecycle durability port. */
  loadActiveSubagentStopTargets(...args: Parameters<CanonicalAgentStore["loadActiveSubagentStopTargets"]>): ReturnType<CanonicalAgentStore["loadActiveSubagentStopTargets"]> {
    return this.reader.loadActiveSubagentStopTargets(...args);
  }

  /** Load the newest durable structured narrative snapshot for an unfinished parent turn. */
  loadParentNarrativeRecovery(...args: Parameters<CanonicalAgentStore["loadParentNarrativeRecovery"]>): ReturnType<CanonicalAgentStore["loadParentNarrativeRecovery"]> {
    return this.reader.loadParentNarrativeRecovery(...args);
  }

  /** Load the accepted user input for one canonical turn. */
  loadUserMessage(...args: Parameters<CanonicalAgentStore["loadUserMessage"]>): ReturnType<CanonicalAgentStore["loadUserMessage"]> {
    return this.reader.loadUserMessage(...args);
  }

  /** Load canonical message and narrative items for one paginated conversation page. */
  loadConversationProjection(...args: Parameters<CanonicalAgentStore["loadConversationProjection"]>): ReturnType<CanonicalAgentStore["loadConversationProjection"]> {
    return this.reader.loadConversationProjection(...args);
  }

  /** Load the provider execution identity that owns one canonical turn. */
  loadExecutionIdForTurn(...args: Parameters<CanonicalAgentStore["loadExecutionIdForTurn"]>): ReturnType<CanonicalAgentStore["loadExecutionIdForTurn"]> {
    return this.reader.loadExecutionIdForTurn(...args);
  }
  /** Resolve with the validated result after the complete writer-owned operation commits. */
  reopenUnmaterializedTerminalCheckpoint(...args: Parameters<CanonicalAgentStore["reopenUnmaterializedTerminalCheckpoint"]>): Promise<ReturnType<CanonicalAgentStore["reopenUnmaterializedTerminalCheckpoint"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.reopenUnmaterializedTerminalCheckpoint, args);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  recordCodexChildRoutingDiagnostic(...args: Parameters<CanonicalAgentStore["recordCodexChildRoutingDiagnostic"]>): Promise<ReturnType<CanonicalAgentStore["recordCodexChildRoutingDiagnostic"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.recordCodexChildRoutingDiagnostic, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  recordCollaborationAction(...args: Parameters<CanonicalAgentStore["recordCollaborationAction"]>): Promise<ReturnType<CanonicalAgentStore["recordCollaborationAction"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.recordCollaborationAction, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  interruptSavedFamilyChildren(...args: Parameters<CanonicalAgentStore["interruptSavedFamilyChildren"]>): Promise<ReturnType<CanonicalAgentStore["interruptSavedFamilyChildren"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.interruptSavedFamilyChildren, args);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  async interruptSubagentTurns(...args: Parameters<CanonicalAgentStore["interruptSubagentTurns"]>): Promise<void> {
    await this.mutate(canonicalRuntimeWriteOperations.interruptSubagentTurns, [[...args[0]], args[1]]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  finishSubagentTurn(...args: Parameters<CanonicalAgentStore["finishSubagentTurn"]>): Promise<ReturnType<CanonicalAgentStore["finishSubagentTurn"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.finishSubagentTurn, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  startCodexChildDelegation(...args: Parameters<CanonicalAgentStore["startCodexChildDelegation"]>): Promise<ReturnType<CanonicalAgentStore["startCodexChildDelegation"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.startCodexChildDelegation, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  markCodexChildDeliveryUnknown(...args: Parameters<CanonicalAgentStore["markCodexChildDeliveryUnknown"]>): Promise<ReturnType<CanonicalAgentStore["markCodexChildDeliveryUnknown"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.markCodexChildDeliveryUnknown, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  markCodexChildDeliveryRejected(...args: Parameters<CanonicalAgentStore["markCodexChildDeliveryRejected"]>): Promise<ReturnType<CanonicalAgentStore["markCodexChildDeliveryRejected"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.markCodexChildDeliveryRejected, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  markUnresolvedCodexChildDeliveriesUnknown(...args: Parameters<CanonicalAgentStore["markUnresolvedCodexChildDeliveriesUnknown"]>): Promise<ReturnType<CanonicalAgentStore["markUnresolvedCodexChildDeliveriesUnknown"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.markUnresolvedCodexChildDeliveriesUnknown, args);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  retryCodexChildDelegation(...args: Parameters<CanonicalAgentStore["retryCodexChildDelegation"]>): Promise<ReturnType<CanonicalAgentStore["retryCodexChildDelegation"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.retryCodexChildDelegation, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  registerCodexReceiverThreadIds(...args: Parameters<CanonicalAgentStore["registerCodexReceiverThreadIds"]>): Promise<ReturnType<CanonicalAgentStore["registerCodexReceiverThreadIds"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.registerCodexReceiverThreadIds, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  bindCodexChildIdentity(...args: Parameters<CanonicalAgentStore["bindCodexChildIdentity"]>): Promise<ReturnType<CanonicalAgentStore["bindCodexChildIdentity"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.bindCodexChildIdentity, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  startCodexChildTurn(...args: Parameters<CanonicalAgentStore["startCodexChildTurn"]>): Promise<ReturnType<CanonicalAgentStore["startCodexChildTurn"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.startCodexChildTurn, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  recordCodexChildItem(...args: Parameters<CanonicalAgentStore["recordCodexChildItem"]>): Promise<ReturnType<CanonicalAgentStore["recordCodexChildItem"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.recordCodexChildItem, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  finishCodexChildTurn(...args: Parameters<CanonicalAgentStore["finishCodexChildTurn"]>): Promise<ReturnType<CanonicalAgentStore["finishCodexChildTurn"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.finishCodexChildTurn, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  finishCanonicalChildTurn(...args: Parameters<CanonicalAgentStore["finishCanonicalChildTurn"]>): Promise<ReturnType<CanonicalAgentStore["finishCanonicalChildTurn"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.finishCanonicalChildTurn, args[0]);
  }

  /** Resolve with the validated result after the complete writer-owned operation commits. */
  recordNativeCursor(...args: Parameters<CanonicalAgentStore["recordNativeCursor"]>): Promise<ReturnType<CanonicalAgentStore["recordNativeCursor"]>> {
    return this.mutate(canonicalRuntimeWriteOperations.recordNativeCursor, args);
  }
}
