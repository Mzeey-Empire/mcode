import type { Message, NarrativeEntry } from "@mcode/contracts";
import type { ToolCallRecordStore } from "../../tools/persistence/tool-call-record-store.js";
import type { ThoughtSegmentStore } from "./persistence/thought-segment-store.js";
import type { HookExecutionStore } from "../../events/persistence/hook-execution-store.js";
type ToolCallRecordRepo = ToolCallRecordStore;
type ThoughtSegmentRepo = ThoughtSegmentStore;
type HookExecutionRepo = HookExecutionStore;

/** Persisted narrative projection accepts only synchronous read capabilities. */
export class NarrativeReadStore {
 constructor(private readonly toolCallRecordRepo: Pick<ToolCallRecordRepo, "listByMessages">, private readonly thoughtSegmentRepo: Pick<ThoughtSegmentRepo, "listByMessages">, private readonly hookExecutionRepo: Pick<HookExecutionRepo, "listByMessages">) {}
loadForMessages(messages: readonly Message[]): NarrativeEntry[] {
    const entries: NarrativeEntry[] = [];
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const assistantMessageIds = assistantMessages.map((m) => m.id);
    const toolsByMessage = this.toolCallRecordRepo.listByMessages(assistantMessageIds);
    const thoughtsByMessage = this.thoughtSegmentRepo.listByMessages(assistantMessageIds);
    const hooksByMessage = this.hookExecutionRepo.listByMessages(assistantMessageIds);

    for (const message of assistantMessages) {
      this.appendAssistantNarrativeEntries(entries, message, {
        tools: toolsByMessage.get(message.id) ?? [],
        thoughts: thoughtsByMessage.get(message.id) ?? [],
        hooks: hooksByMessage.get(message.id) ?? [],
      });
    }

    return entries.sort(
      (a, b) => a.sequence - b.sequence || a.sortOrder - b.sortOrder,
    );
  }

private appendAssistantNarrativeEntries(
    entries: NarrativeEntry[],
    message: Message,
    records: {
      tools: ReturnType<ToolCallRecordRepo["listByMessages"]> extends Map<string, infer T> ? T : never;
      thoughts: ReturnType<ThoughtSegmentRepo["listByMessages"]> extends Map<string, infer T> ? T : never;
      hooks: ReturnType<HookExecutionRepo["listByMessages"]> extends Map<string, infer T> ? T : never;
    },
  ): void {
    const finalSegment = records.thoughts.find((thought) => (thought.is_final_response ?? 0) !== 0);
    entries.push({
      kind: "assistantMessage",
      messageId: message.id,
      sequence: message.sequence,
      body: message.content,
      sortOrder: finalSegment?.sort_order ?? Number.MAX_SAFE_INTEGER,
    });
    this.appendToolCallEntries(entries, message.sequence, records.tools);
    this.appendThoughtEntries(entries, message.sequence, records.thoughts);
    this.appendHookEntries(entries, message.sequence, records.hooks);
  }

private appendToolCallEntries(
    entries: NarrativeEntry[],
    sequence: number,
    tools: ReturnType<ToolCallRecordRepo["listByMessages"]> extends Map<string, infer T> ? T : never,
  ): void {
    for (const tool of tools) entries.push({ kind: "toolCall", sequence, sortOrder: tool.sort_order, record: tool });
  }

private appendThoughtEntries(
    entries: NarrativeEntry[],
    sequence: number,
    thoughts: ReturnType<ThoughtSegmentRepo["listByMessages"]> extends Map<string, infer T> ? T : never,
  ): void {
    for (const thought of thoughts) {
      if ((thought.is_final_response ?? 0) === 0) {
        entries.push({ kind: "narrationSegment", sequence, sortOrder: thought.sort_order, record: thought });
      }
    }
  }

private appendHookEntries(
    entries: NarrativeEntry[],
    sequence: number,
    hooks: ReturnType<HookExecutionRepo["listByMessages"]> extends Map<string, infer T> ? T : never,
  ): void {
    for (const hook of hooks) entries.push({ kind: "hook", sequence, sortOrder: hook.sort_order, record: hook });
  }
}
