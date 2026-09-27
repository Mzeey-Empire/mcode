import type { AgentEvent, ProviderFileMutationStart, TurnOutcome } from "@mcode/contracts";

import type { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import type { PreparedTurnDiffEvidence, TurnDiffService } from "../turns/turn-diff-service.js";
import {
  prepareExecutionFileEvidence,
  type PreparedExecutionFileEvidence,
} from "../turns/turn-execution-file-evidence.js";
import type {
  CapturedToolUseObservation,
  FileTurnHandoff,
  TurnFileTracker,
} from "../turns/turn-file-tracker.js";
import { ExecutionFileObservationHandoff } from "./execution-file-observation-handoff.js";

type ToolUse = Extract<AgentEvent, { type: "toolUse" }>;
type DiffHandoff = Pick<TurnDiffService, "begin" | "takeFinalizationEvidence" | "clearExecution">;

/** Cloneable terminal file data retained until the writer acknowledges finalization. */
export interface FrozenExecutionFileEvidence {
  readonly handoff: FileTurnHandoff;
  readonly turnId: string;
  readonly deliveryAttempt: number;
  readonly outcome: TurnOutcome;
  readonly nativeDiff: PreparedTurnDiffEvidence | null;
}

interface ActiveFileExecution {
  readonly handoff: FileTurnHandoff;
  readonly turnId: string;
  readonly deliveryAttempt: number;
  readonly observations: ExecutionFileObservationHandoff;
  frozen?: FrozenExecutionFileEvidence;
}

/** Captures pre-edit evidence on the provider callback and seals one attempt for worker settlement. */
export class ExecutionFileEvidenceCoordinator {
  private readonly active = new Map<string, ActiveFileExecution>();

  constructor(
    private readonly captureTracker: TurnFileTracker,
    private readonly diffs: DiffHandoff,
  ) {}

  /** Open the exact execution only after its durable start has been acknowledged. */
  begin(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly executionId: string;
    readonly deliveryAttempt: number;
    readonly cwd: string;
    readonly baselineRef: string | null;
  }): FileTurnHandoff {
    if (!input.turnId || !Number.isSafeInteger(input.deliveryAttempt) || input.deliveryAttempt < 1) {
      throw new Error("File evidence requires a turn ID and positive delivery attempt");
    }
    const previous = this.active.get(input.threadId);
    if (previous?.frozen) throw new Error("Retire sealed file evidence before opening another attempt");
    const handoff = this.captureTracker.beginExecutionTurn(input);
    const observations = new ExecutionFileObservationHandoff(
      this.captureTracker, handoff, input.deliveryAttempt,
    );
    previous?.observations.close();
    if (previous) this.captureTracker.clearTurn(input.threadId, previous.handoff.generation);
    this.diffs.begin({ threadId: input.threadId, turnId: input.turnId,
      turnExecutionId: input.executionId, deliveryAttempt: input.deliveryAttempt });
    this.active.set(input.threadId, {
      handoff, turnId: input.turnId, deliveryAttempt: input.deliveryAttempt, observations,
    });
    return handoff;
  }

  /** Run synchronously before the provider is allowed to mutate a named file. */
  capture(event: ProviderFileMutationStart): boolean {
    return this.active.get(event.threadId)?.observations.capture(event) ?? false;
  }

  /** Transfer the original pre-edit observation with its matching admitted tool event. */
  take(event: ToolUse, deliveryAttempt: number): CapturedToolUseObservation | null {
    return this.active.get(event.threadId)?.observations.take(event, deliveryAttempt) ?? null;
  }

  /** Reject later callbacks at the Stop or retry cut while retaining settled evidence. */
  fence(threadId: string, executionId: string, deliveryAttempt: number): boolean {
    const active = this.match(threadId, executionId, deliveryAttempt);
    if (!active) return false;
    active.observations.close();
    return true;
  }

  /** Freeze native evidence before asynchronous file settlement or terminal publication. */
  seal(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly executionId: string;
    readonly deliveryAttempt: number;
    readonly outcome: TurnOutcome;
  }): FrozenExecutionFileEvidence | null {
    const active = this.match(input.threadId, input.executionId, input.deliveryAttempt);
    if (!active || active.turnId !== input.turnId) return null;
    if (active.frozen) {
      if (active.frozen.outcome !== input.outcome) throw new Error("File evidence outcome changed after sealing");
      return active.frozen;
    }
    active.observations.close();
    const nativeDiff = this.diffs.takeFinalizationEvidence(input.threadId, input.executionId);
    if (nativeDiff && (nativeDiff.turnId !== input.turnId
      || nativeDiff.turnExecutionId !== input.executionId
      || nativeDiff.deliveryAttempt !== input.deliveryAttempt)) {
      throw new Error("Native diff does not belong to the sealed execution attempt");
    }
    active.frozen = Object.freeze({
      handoff: active.handoff, turnId: input.turnId,
      deliveryAttempt: input.deliveryAttempt, outcome: input.outcome, nativeDiff,
    });
    return active.frozen;
  }

  /** Release the capture tracker only after the terminal writer receipt or explicit abandonment. */
  retire(threadId: string, executionId: string, deliveryAttempt: number): boolean {
    const active = this.match(threadId, executionId, deliveryAttempt);
    if (!active) return false;
    active.observations.close();
    this.active.delete(threadId);
    this.diffs.clearExecution(threadId, executionId);
    this.captureTracker.clearTurn(threadId, active.handoff.generation);
    return true;
  }

  private match(threadId: string, executionId: string, deliveryAttempt: number): ActiveFileExecution | null {
    const active = this.active.get(threadId);
    return active?.handoff.executionId === executionId && active.deliveryAttempt === deliveryAttempt
      ? active : null;
  }
}

/** Settle a frozen attempt on its execution worker before the terminal writer operation. */
export function prepareFrozenExecutionFileEvidence(
  frozen: FrozenExecutionFileEvidence,
  tracker: TurnFileTracker,
  snapshots: SnapshotService,
): Promise<PreparedExecutionFileEvidence> {
  return prepareExecutionFileEvidence({
    handoff: frozen.handoff,
    turnId: frozen.turnId,
    deliveryAttempt: frozen.deliveryAttempt,
    outcome: frozen.outcome,
    nativeDiff: frozen.nativeDiff,
    tracker,
    snapshots,
  });
}
