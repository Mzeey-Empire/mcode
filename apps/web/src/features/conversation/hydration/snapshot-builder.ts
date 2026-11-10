import type { Message } from "@/transport";
import type { TurnSnapshot } from "@mcode/contracts/models/turn-snapshot";
import type { TurnFileEvidenceEvent } from "@mcode/contracts/models/turn-file-evidence";
import { providerNoticeSessionId, type ThreadRecord } from "@/stores/thread-record";
import { EMPTY_FILE_EVIDENCE, mergeFileEvidence, recordedEvidencePaths } from "@/stores/thread-store/file-evidence";

/** Raw RPC inputs used to assemble a canonical thread-record patch. */
export interface SnapshotBuilderInput {
  messages: Message[];
  sessionNotices?: Message[];
  hasMore: boolean;
  answeredPlanMessageIds?: string[];
  snapshots?: TurnSnapshot[];
  /** Per-execution file evidence from the same page; rows win over snapshot rows. */
  turnFileEvidence?: TurnFileEvidenceEvent[];
}

/** Derived file-change fields from turn snapshot rows. */
export interface FileChangeFields {
  persistedFilesChanged: Record<string, string[]>;
  latestTurnWithChanges: string | null;
  fileEffectSummary: ThreadRecord["fileEffectSummary"];
}

/**
 * The slice of {@link ThreadRecord} fields owned by the snapshot builder.
 * The builder is pure: no IO, no store writes. Hydrator commits this patch.
 */
export type ThreadRecordPatch = Pick<
  ThreadRecord,
  | "messages"
  | "sessionNotices"
  | "noticeSessionId"
  | "oldestLoadedSequence"
  | "newestLoadedSequence"
  | "hasMoreMessages"
  | "hasNewerMessages"
  | "persistedToolCallCounts"
  | "persistedFilesChanged"
  | "latestTurnWithChanges"
  | "fileEffectSummary"
  | "fileEvidence"
  | "answeredPlanMessageIds"
>;

/**
 * Pure builder for the message-load slice of a {@link ThreadRecord}.
 * No IO — rollup of tool-call counts, file-change map, and pagination cursors.
 */
export class SnapshotBuilder {
  /**
   * Build a {@link ThreadRecordPatch} from message and snapshot RPC results.
   */
  build(input: SnapshotBuilderInput): ThreadRecordPatch {
    const {
      messages,
      sessionNotices = [],
      hasMore,
      answeredPlanMessageIds,
    } = input;

    const persistedToolCallCounts: Record<string, number> = {};
    for (const msg of messages) {
      if (msg.tool_call_count && msg.tool_call_count > 0) {
        persistedToolCallCounts[msg.id] = msg.tool_call_count;
      }
    }

    const oldestLoadedSequence = messages.length > 0 ? messages[0].sequence : 0;
    const newestLoadedSequence = messages.at(-1)?.sequence ?? 0;
    const fileChanges = SnapshotBuilder.deriveEvidenceFileChanges(messages, input);

    return {
      messages: messages.map((message) => ({ ...message, serverSequence: message.sequence })),
      sessionNotices,
      noticeSessionId: providerNoticeSessionId(sessionNotices),
      oldestLoadedSequence,
      newestLoadedSequence,
      hasMoreMessages: hasMore,
      hasNewerMessages: false,
      persistedToolCallCounts,
      ...fileChanges,
      answeredPlanMessageIds: new Set(answeredPlanMessageIds ?? []),
    };
  }

  /** Evidence rows own their paths; executions without a row are legacy turns and keep their snapshot-row paths. */
  private static deriveEvidenceFileChanges(
    messages: readonly Message[],
    { snapshots = [], turnFileEvidence = [] }: Pick<SnapshotBuilderInput, "snapshots" | "turnFileEvidence">,
  ): FileChangeFields & Pick<ThreadRecord, "fileEvidence"> {
    const fileChanges = SnapshotBuilder.deriveFileChanges(snapshots);
    const fileEvidence = mergeFileEvidence(EMPTY_FILE_EVIDENCE, turnFileEvidence);
    const persistedFilesChanged = { ...fileChanges.persistedFilesChanged, ...recordedEvidencePaths(fileEvidence) };
    return {
      persistedFilesChanged,
      latestTurnWithChanges: latestMessageWithChanges(messages, persistedFilesChanged) ?? fileChanges.latestTurnWithChanges,
      fileEffectSummary: fileChanges.fileEffectSummary,
      fileEvidence,
    };
  }

  /**
   * Derive the file-change map and latest-turn pointer from snapshot rows.
   * Snapshots arrive sorted by created_at ASC, so the last match wins.
   */
  static deriveFileChanges(snapshots: TurnSnapshot[]): FileChangeFields {
    const persistedFilesChanged: Record<string, string[]> = {};
    let latestTurnWithChanges: string | null = null;
    let fileEffectSummary: ThreadRecord["fileEffectSummary"] = {
      revision: 0,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      effects: [],
    };

    for (const snap of snapshots) {
      if (snap.file_effects) fileEffectSummary = snap.file_effects;
      if (snap.files_changed.length === 0) continue;
      persistedFilesChanged[snap.message_id] = snap.files_changed;
      latestTurnWithChanges = snap.message_id;
    }

    return { persistedFilesChanged, latestTurnWithChanges, fileEffectSummary };
  }
}

function latestMessageWithChanges(messages: readonly Message[], persistedFilesChanged: Record<string, string[]>): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const id = messages[index]!.id;
    if ((persistedFilesChanged[id]?.length ?? 0) > 0) return id;
  }
  return null;
}

/** Shared singleton for hydrator call sites. */
export const snapshotBuilder = new SnapshotBuilder();
