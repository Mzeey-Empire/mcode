/**
 * NarrativeStore — single home for the narrative pipeline's read side (and,
 * after the candidate-A write-seam extraction, its enrichment + classification
 * + persistence too).
 *
 * Read seam: {@link NarrativeStore.load} returns one chronologically-ordered
 * list of {@link NarrativeEntry} for a thread, interleaving assistant message
 * bodies, tool calls, narration segments, and hooks by (sequence, sortOrder).
 * The client renders this list in payload order, so reloaded turns no longer
 * race two hydration streams (the old `message.list` + `narrative.list` pair)
 * and Tool calls never render before the assistant message body.
 */
import { injectable, inject } from "tsyringe";
import type { NarrativeEntry, TurnRange } from "@mcode/contracts";
import { MessageRepo } from "../repositories/message-repo";
import { ToolCallRecordRepo } from "../repositories/tool-call-record-repo";
import { ThoughtSegmentRepo } from "../repositories/thought-segment-repo";
import { HookExecutionRepo } from "../repositories/hook-execution-repo";

/** Default number of recent messages hydrated when no range is supplied. */
const DEFAULT_LOAD_LIMIT = 200;

@injectable()
export class NarrativeStore {
  constructor(
    @inject(MessageRepo) private readonly messageRepo: MessageRepo,
    @inject(ToolCallRecordRepo) private readonly toolCallRecordRepo: ToolCallRecordRepo,
    @inject(ThoughtSegmentRepo) private readonly thoughtSegmentRepo: ThoughtSegmentRepo,
    @inject(HookExecutionRepo) private readonly hookExecutionRepo: HookExecutionRepo,
  ) {}

  /**
   * Load a thread's persisted narrative as one chronologically-ordered list.
   *
   * Entries are ordered by `(message.sequence, sortOrder)`. For each assistant
   * message, the final-response narration segment is surfaced as the
   * `assistantMessage` entry (carrying the message body and that segment's
   * sort order) rather than as a separate narration row, so the final response
   * is the message body and never appears as a duplicate preamble. Preamble
   * narration, tool calls, and hooks for the same message interleave by their
   * own sort order. User and system messages are not narrative and are skipped.
   */
  load(threadId: string, range?: TurnRange): NarrativeEntry[] {
    const { messages } = this.messageRepo.listByThread(
      threadId,
      range?.limit ?? DEFAULT_LOAD_LIMIT,
      range?.before,
    );

    const entries: NarrativeEntry[] = [];
    for (const m of messages) {
      if (m.role !== "assistant") continue;

      const tools = this.toolCallRecordRepo.listByMessage(m.id);
      const thoughts = this.thoughtSegmentRepo.listByMessage(m.id);
      const hooks = this.hookExecutionRepo.listByMessage(m.id);

      const finalSeg = thoughts.find((t) => (t.is_final_response ?? 0) !== 0);
      entries.push({
        kind: "assistantMessage",
        messageId: m.id,
        sequence: m.sequence,
        body: m.content,
        // Body sorts where its final-response segment sat; absent (tool-free
        // or older rows) it sorts after this message's other entries.
        sortOrder: finalSeg?.sort_order ?? Number.MAX_SAFE_INTEGER,
      });

      for (const t of tools) {
        entries.push({ kind: "toolCall", sequence: m.sequence, sortOrder: t.sort_order, record: t });
      }
      for (const seg of thoughts) {
        if ((seg.is_final_response ?? 0) !== 0) continue; // already the assistantMessage body
        entries.push({
          kind: "narrationSegment",
          sequence: m.sequence,
          sortOrder: seg.sort_order,
          record: seg,
        });
      }
      for (const h of hooks) {
        entries.push({ kind: "hook", sequence: m.sequence, sortOrder: h.sort_order, record: h });
      }
    }

    return entries.sort(
      (a, b) => a.sequence - b.sequence || a.sortOrder - b.sortOrder,
    );
  }
}
