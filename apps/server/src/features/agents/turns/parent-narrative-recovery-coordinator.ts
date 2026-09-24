import * as NodeCrypto from "node:crypto";
import { logger } from "@mcode/shared";
import {
  AgentEventType,
  type AgentEvent,
  type ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import type { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import type { CanonicalAgentWriterClient } from "../canonical/canonical-agent-writer-client.js";
import type { ParentNarrativeRecoveryCommit } from "./parent-turn-durability.js";
import { serverWorkTrace } from "../diagnostics/server-work-trace.js";

/** The single acknowledged writer used for recovery and text classification. */
export const PARENT_NARRATIVE_RECOVERY_WRITER = Symbol("ParentNarrativeRecoveryWriter");
export type ParentNarrativeRecoveryWriter = Pick<CanonicalAgentWriterClient,
  "recordParentNarrativeRecovery" | "classifyParentNarrativeRecovery" | "acknowledgeOperation">;

interface ParentNarrativeRecoveryCheckpoint {
  operationId: string;
  input: ParentNarrativeRecoveryCommit;
  committed: boolean;
  confirm(): void;
}

/** Commits changed structured narrative records before AgentService publishes their source event. */
export class ParentNarrativeRecoveryCoordinator {
  private readonly fingerprintsByExecution = new Map<string, Map<string, string>>();
  private readonly preparedByEvent = new WeakMap<object, ParentNarrativeRecoveryCheckpoint>();

  constructor(
    private readonly writer: ParentNarrativeRecoveryWriter,
    private readonly narrativeStore: NarrativeStore,
  ) {}

  /** Commit only the semantic records changed by this accepted provider event. */
  checkpoint(event: AgentEvent): Promise<void> | void {
    const checkpoint = this.prepareCheckpoint(event);
    if (!checkpoint || checkpoint.committed) return;
    const persist = () => this.writer.recordParentNarrativeRecovery(checkpoint.operationId, checkpoint.input);
    const pending = serverWorkTrace
      ? serverWorkTrace.measure("narrative-persist", event.threadId, event.turnExecutionId, persist)
      : persist();
    return pending.then((receipt) => {
      if (receipt.recorded) {
        if (serverWorkTrace) {
          serverWorkTrace.measure("narrative-confirm", event.threadId, event.turnExecutionId, checkpoint.confirm);
        } else checkpoint.confirm();
      }
      checkpoint.committed = true;
    });
  }

  /** Commit staged narration and reset provisional assistant text in one writer transaction. */
  async classify(
    event: AgentEvent,
    snapshot: readonly ParentNarrativeRecoveryItem[],
  ): Promise<void> {
    const checkpoint = this.prepareCheckpoint(event, snapshot, true);
    if (!checkpoint) throw new Error("Narrative classification requires a turn execution");
    await this.writer.classifyParentNarrativeRecovery(checkpoint.operationId, checkpoint.input);
    checkpoint.confirm();
    checkpoint.committed = true;
  }

  /** Release a receipt only after its source event was actually published or its recovery journal retired. */
  acknowledgeHandled(event: AgentEvent): void {
    const checkpoint = this.preparedByEvent.get(event as object);
    if (!checkpoint?.committed) return;
    this.preparedByEvent.delete(event as object);
    const { executionId } = checkpoint.input;
    void this.writer.acknowledgeOperation(executionId, checkpoint.operationId).catch(() => {
      logger.warn("Canonical narrative receipt acknowledgement failed", {
        executionId,
        operationId: checkpoint.operationId,
      });
    });
  }

  private prepareCheckpoint(
    event: AgentEvent,
    snapshot?: readonly ParentNarrativeRecoveryItem[],
    force = false,
  ): ParentNarrativeRecoveryCheckpoint | null {
    if (!this.requiresStructuredRecovery(event) || !event.turnExecutionId) return null;
    const existing = this.preparedByEvent.get(event as object);
    if (existing) return existing;
    const executionId = event.turnExecutionId;
    const prepare = () => this.buildCheckpoint(event, executionId, snapshot, force);
    return serverWorkTrace
      ? serverWorkTrace.measure("narrative-prepare", event.threadId, event.turnExecutionId, prepare)
      : prepare();
  }

  private buildCheckpoint(
    event: AgentEvent,
    executionId: string,
    snapshot: readonly ParentNarrativeRecoveryItem[] | undefined,
    force: boolean,
  ): ParentNarrativeRecoveryCheckpoint | null {
    const snapshots = snapshot ?? this.narrativeStore.recoverySnapshot(event.threadId);
    const fingerprints = this.fingerprintsByExecution.get(executionId) ?? new Map<string, string>();
    const nextFingerprints = new Map<string, string>();
    const currentKeys = new Set(snapshots.map((item) => `${item.kind}:${item.record.id}`));
    const changed = snapshots.filter((item) => {
      const key = `${item.kind}:${item.record.id}`;
      const fingerprint = JSON.stringify(item);
      nextFingerprints.set(key, fingerprint);
      return fingerprints.get(key) !== fingerprint;
    });
    const discardedItemIds = [...fingerprints.keys()]
      .filter((key) => !currentKeys.has(key))
      .map((key) => this.canonicalItemId(key));
    if (!force && changed.length === 0 && discardedItemIds.length === 0) return null;
    const prepared = {
      operationId: `narrative:${NodeCrypto.randomUUID()}`,
      input: { executionId, items: changed, discardedItemIds },
      committed: false,
      confirm: () => this.fingerprintsByExecution.set(executionId, nextFingerprints),
    };
    this.preparedByEvent.set(event as object, prepared);
    return prepared;
  }

  /** Forget volatile dedupe state after a terminal turn releases its buffers. */
  clear(executionId: string | undefined): void {
    if (!executionId) return;
    this.fingerprintsByExecution.delete(executionId);
  }

  private requiresStructuredRecovery(event: AgentEvent): boolean {
    return event.type === AgentEventType.TextDelta
      || event.type === AgentEventType.AssistantMessageBoundary
      || event.type === AgentEventType.ToolUse
      || event.type === AgentEventType.ToolResult
      || event.type === AgentEventType.HookStarted
      || event.type === AgentEventType.HookCompleted;
  }

  private canonicalItemId(key: string): string {
    const separator = key.indexOf(":");
    const kind = separator < 0 ? "" : key.slice(0, separator);
    const id = separator < 0 ? "" : key.slice(separator + 1);
    if (!kind || !id) throw new Error(`Invalid narrative recovery identity: ${key}`);
    return kind === "toolCall" ? `toolCall:${id}` : `${kind}:${id}`;
  }
}
