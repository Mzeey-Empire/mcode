import type { TurnFileEffectSummary, TurnOutcome } from "@mcode/contracts";

import type { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import type { CreateTurnSnapshotInput } from "./persistence/turn-snapshot-repo.js";
import type { FileTurnHandoff, TurnFileTracker } from "./turn-file-tracker.js";
import {
  selectTurnDiffSettlement,
  type PreparedTurnDiffEvidence,
  type SelectedTurnDiff,
} from "./turn-diff-service.js";

/** Cloneable snapshot data whose message ID is assigned by the terminal writer. */
export interface ExecutionTurnSnapshot extends Omit<CreateTurnSnapshotInput, "messageId"> {
  readonly executionId: string;
}

/** File data retained through a failed writer attempt and retired only after its receipt. */
export interface PreparedExecutionFileEvidence {
  readonly threadId: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly deliveryAttempt: number;
  readonly fileEffects: TurnFileEffectSummary;
  readonly filesChanged: readonly string[];
  readonly snapshot: ExecutionTurnSnapshot | null;
  readonly selectedTurnDiff: SelectedTurnDiff | null;
}

/** Settle one sealed file generation before sending terminal data to the sole writer. */
export async function prepareExecutionFileEvidence(input: {
  readonly handoff: FileTurnHandoff;
  readonly turnId: string;
  readonly deliveryAttempt: number;
  readonly outcome: TurnOutcome;
  readonly nativeDiff: PreparedTurnDiffEvidence | null;
  readonly tracker: TurnFileTracker;
  readonly snapshots: SnapshotService;
}): Promise<PreparedExecutionFileEvidence> {
  const { handoff, tracker, snapshots } = input;
  const evidence = await tracker.finalEvidenceForExecution(handoff);
  if (!evidence) throw new Error(`File evidence generation no longer belongs to execution ${handoff.executionId}`);
  assertNativeDiffOwner(input);

  const fileEffects = evidence.summary;
  const { snapshot, filesChanged } = await prepareSnapshot(handoff, evidence.baselineRef, fileEffects, snapshots);
  return {
    threadId: handoff.threadId,
    turnId: input.turnId,
    executionId: handoff.executionId,
    deliveryAttempt: input.deliveryAttempt,
    fileEffects,
    filesChanged,
    snapshot,
    selectedTurnDiff: input.nativeDiff
      ? selectTurnDiffSettlement(input.nativeDiff, input.outcome, fileEffects, evidence.reconstructionPatch)
      : null,
  };
}

function assertNativeDiffOwner(input: {
  readonly nativeDiff: PreparedTurnDiffEvidence | null;
  readonly handoff: FileTurnHandoff;
  readonly turnId: string;
  readonly deliveryAttempt: number;
}): void {
  const diff = input.nativeDiff;
  if (!diff) return;
  if (diff.threadId !== input.handoff.threadId || diff.turnId !== input.turnId
    || diff.turnExecutionId !== input.handoff.executionId
    || diff.deliveryAttempt !== input.deliveryAttempt) {
    throw new Error(`Native diff does not belong to execution ${input.handoff.executionId}`);
  }
}

async function prepareSnapshot(
  handoff: FileTurnHandoff,
  refBefore: string | null,
  fileEffects: TurnFileEffectSummary,
  snapshots: SnapshotService,
): Promise<{ snapshot: ExecutionTurnSnapshot | null; filesChanged: string[] }> {
  const refAfter = refBefore ? await snapshots.captureRef(handoff.cwd) : null;
  const filesChanged = fileEffects.effects.filter((effect) => effect.scope === "workspace")
    .map((effect) => effect.path);
  if (fileEffects.fileCount === 0 && !(refBefore && refAfter)) return { snapshot: null, filesChanged };
  return { filesChanged, snapshot: {
    threadId: handoff.threadId,
    executionId: handoff.executionId,
    refBefore: refBefore ?? "",
    refAfter: refAfter ?? "",
    filesChanged,
    fileEffects,
    worktreePath: null,
  } };
}
