import "reflect-metadata";
import type { AgentEvent, TurnFileEffectSummary } from "@mcode/contracts";
import { hostRuntime } from "@mcode/shared/node/host-runtime";

import { RealGitExecutor } from "../../projects/git/execution/real-git-executor.js";
import { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import { TurnFileTracker, type CapturedToolUseObservation, type FileTurnHandoff } from "../turns/turn-file-tracker.js";
import type { PreparedExecutionFileEvidence } from "../turns/turn-execution-file-evidence.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";
import {
  prepareFrozenExecutionFileEvidence,
  type FrozenExecutionFileEvidence,
} from "./execution-file-evidence-coordinator.js";

type ToolUse = Extract<AgentEvent, { type: "toolUse" }>;
type ToolResult = Extract<AgentEvent, { type: "toolResult" }>;
const MAX_OPEN_TOOL_CALLS = 64;

interface ActiveFileExecution {
  readonly execution: ExecutionIdentity;
  readonly deliveryAttempt: number;
  readonly handoff: FileTurnHandoff;
  readonly openToolCalls: Set<string>;
  sealed: boolean;
  settlement?: Promise<PreparedExecutionFileEvidence>;
}

/** Runs file attribution and terminal settlement on the execution worker, with no database access. */
export class ExecutionWorkerFileEvidence {
  private readonly active = new Map<string, ActiveFileExecution>();
  private readonly tracker: TurnFileTracker;

  constructor(private readonly snapshots = new SnapshotService(new RealGitExecutor())) {
    this.tracker = new TurnFileTracker(
      (cwd, ref, path) => snapshots.getFileAtRef(cwd, ref, path),
      () => {},
      hostRuntime.platform,
    );
  }

  /** Install the main-loop handoff only against the scheduler's independent cwd and execution. */
  begin(input: {
    readonly execution: ExecutionIdentity;
    readonly deliveryAttempt: number;
    readonly cwd: string;
    readonly handoff: FileTurnHandoff;
  }): boolean {
    if (!Number.isSafeInteger(input.deliveryAttempt) || input.deliveryAttempt < 1) return false;
    const { execution, handoff } = input;
    const current = this.active.get(execution.threadId);
    if (current) return this.matches(current, execution, input.deliveryAttempt)
      && current.handoff.generationToken === handoff.generationToken;
    if (!this.tracker.beginTurnFromHandoff(handoff, {
      threadId: execution.threadId, executionId: execution.executionId, cwd: input.cwd,
    })) return false;
    this.active.set(execution.threadId, {
      execution, deliveryAttempt: input.deliveryAttempt, handoff,
      openToolCalls: new Set(), sealed: false,
    });
    return true;
  }

  /** Attach the captured pre-edit state before processing the matching tool event. */
  async observeToolUse(input: {
    readonly execution: ExecutionIdentity;
    readonly deliveryAttempt: number;
    readonly event: ToolUse;
    readonly captured: CapturedToolUseObservation | null;
  }): Promise<boolean> {
    const active = this.activeFor(input.execution, input.deliveryAttempt);
    if (!active || active.sealed || !input.captured || !this.matchesEvent(active, input.event)
      || active.openToolCalls.has(input.event.toolCallId)
      || active.openToolCalls.size >= MAX_OPEN_TOOL_CALLS) return false;
    const observed = await this.tracker.observeCapturedToolUse(input.event, input.captured);
    if (observed) active.openToolCalls.add(input.event.toolCallId);
    return observed;
  }

  /** Recompute the tracked net effect after a previously captured tool finishes. */
  async observeToolResult(input: {
    readonly execution: ExecutionIdentity;
    readonly deliveryAttempt: number;
    readonly event: ToolResult;
  }): Promise<TurnFileEffectSummary | null> {
    const active = this.activeFor(input.execution, input.deliveryAttempt);
    if (!active || active.sealed || !this.matchesEvent(active, input.event)
      || !active.openToolCalls.has(input.event.toolCallId)) return null;
    await this.tracker.observeToolResult(active.execution.threadId, input.event.toolCallId);
    active.openToolCalls.delete(input.event.toolCallId);
    return this.tracker.finalizeTurn(active.execution.threadId, active.handoff.generation);
  }

  /** Apply a baseline captured after start to this attempt's tracker generation only. */
  async setBaselineRef(execution: ExecutionIdentity, deliveryAttempt: number, ref: string): Promise<boolean> {
    const active = this.activeFor(execution, deliveryAttempt);
    if (!active || active.sealed) return false;
    await this.tracker.setBaselineRef(execution.threadId, active.handoff.generation, ref);
    return true;
  }

  /** Freeze exact attempt evidence before the one terminal writer operation. */
  settle(frozen: FrozenExecutionFileEvidence): Promise<PreparedExecutionFileEvidence | null> {
    const active = this.active.get(frozen.handoff.threadId);
    if (!active || !this.matches(active, {
      threadId: frozen.handoff.threadId, turnId: frozen.turnId,
      executionId: frozen.handoff.executionId,
    }, frozen.deliveryAttempt)
      || active.handoff.generation !== frozen.handoff.generation
      || active.handoff.generationToken !== frozen.handoff.generationToken) return Promise.resolve(null);
    if (active.settlement) return active.settlement;
    active.sealed = true;
    const settlement = this.settleActive(active, frozen);
    active.settlement = settlement;
    void settlement.catch(() => {
      if (active.settlement === settlement) active.settlement = undefined;
    });
    return settlement;
  }

  /** Clear a settled generation only after its final writer receipt. */
  retire(execution: ExecutionIdentity, deliveryAttempt: number): boolean {
    const active = this.activeFor(execution, deliveryAttempt);
    if (!active) return false;
    this.active.delete(execution.threadId);
    this.tracker.clearTurn(execution.threadId, active.handoff.generation);
    return true;
  }

  private activeFor(execution: ExecutionIdentity, deliveryAttempt: number): ActiveFileExecution | null {
    const active = this.active.get(execution.threadId);
    return active && this.matches(active, execution, deliveryAttempt) ? active : null;
  }

  private matches(active: ActiveFileExecution, execution: ExecutionIdentity, deliveryAttempt: number): boolean {
    return active.execution.threadId === execution.threadId
      && active.execution.turnId === execution.turnId
      && active.execution.executionId === execution.executionId
      && active.deliveryAttempt === deliveryAttempt;
  }

  private matchesEvent(active: ActiveFileExecution, event: ToolUse | ToolResult): boolean {
    return event.threadId === active.execution.threadId
      && event.turnExecutionId === active.execution.executionId;
  }

  private async settleActive(
    active: ActiveFileExecution,
    frozen: FrozenExecutionFileEvidence,
  ): Promise<PreparedExecutionFileEvidence> {
    for (const toolCallId of active.openToolCalls) {
      await this.tracker.observeToolResult(active.execution.threadId, toolCallId);
    }
    active.openToolCalls.clear();
    return prepareFrozenExecutionFileEvidence(frozen, this.tracker, this.snapshots);
  }
}
