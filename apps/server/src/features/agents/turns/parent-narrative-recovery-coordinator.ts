import {
  AgentEventType,
  type AgentEvent,
  type ParentNarrativeRecoveryItem,
} from "@mcode/contracts";
import type { ParentTurnDurability } from "./parent-turn-durability.js";
import type { NarrativeStore } from "../conversation/narrative/narrative-store.js";
import { serverWorkTrace } from "../diagnostics/server-work-trace.js";
import { NarrativeRecoveryDelta } from "./narrative-recovery-delta.js";

interface ParentNarrativeRecoveryCheckpoint {
  persist(): void;
  confirm(): void;
}

/** Commits changed structured narrative records before AgentService publishes their source event. */
export class ParentNarrativeRecoveryCoordinator {
  private readonly deltasByExecution = new Map<string, NarrativeRecoveryDelta>();

  constructor(
    private readonly canonicalSink: ParentTurnDurability,
    private readonly narrativeStore: NarrativeStore,
  ) {}

  /** Commit only the semantic records changed by this accepted provider event. */
  checkpoint(event: AgentEvent): void {
    if (!serverWorkTrace) {
      const checkpoint = this.prepareCheckpoint(event);
      if (!checkpoint) return;
      checkpoint.persist();
      checkpoint.confirm();
      return;
    }
    const checkpoint = serverWorkTrace.measure("narrative-prepare", event.threadId,
      event.turnExecutionId, () => this.prepareCheckpoint(event));
    if (!checkpoint) return;
    serverWorkTrace.measure("narrative-persist", event.threadId,
      event.turnExecutionId, () => checkpoint.persist());
    serverWorkTrace.measure("narrative-confirm", event.threadId,
      event.turnExecutionId, () => checkpoint.confirm());
  }

  /** Prepare a recovery commit whose dedupe state advances only after its transaction commits. */
  prepareCheckpoint(
    event: AgentEvent,
    snapshot?: readonly ParentNarrativeRecoveryItem[],
  ): ParentNarrativeRecoveryCheckpoint | null {
    const executionId = event.turnExecutionId;
    if (!this.requiresStructuredRecovery(event) || !executionId) return null;
    if (!this.canonicalSink.loadTurnByExecution(executionId)) return null;
    const snapshots = snapshot ?? this.narrativeStore.recoverySnapshot(event.threadId);
    const delta = this.deltasByExecution.get(executionId) ?? new NarrativeRecoveryDelta();
    const prepared = delta.prepare(snapshots);
    if (!prepared) return null;
    this.deltasByExecution.set(executionId, delta);
    return {
      persist: () => {
        const committed = this.canonicalSink.recordParentNarrativeRecovery({
          executionId,
          items: prepared.items,
          discardedItemIds: prepared.discardedItemIds,
        });
        if (!committed) {
          throw new Error(`Canonical parent turn was not found: ${executionId}`);
        }
      },
      confirm: () => prepared.acknowledge(),
    };
  }

  /** Forget volatile dedupe state after a terminal turn releases its buffers. */
  clear(executionId: string | undefined): void {
    if (executionId) this.deltasByExecution.delete(executionId);
  }

  private requiresStructuredRecovery(event: AgentEvent): boolean {
    return event.type === AgentEventType.TextDelta
      || event.type === AgentEventType.AssistantMessageBoundary
      || event.type === AgentEventType.ToolUse
      || event.type === AgentEventType.ToolResult
      || event.type === AgentEventType.HookStarted
      || event.type === AgentEventType.HookCompleted;
  }
}
