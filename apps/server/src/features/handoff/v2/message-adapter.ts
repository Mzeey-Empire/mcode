import { z } from "zod";
import type { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import type { ToolCallRecordRepo } from "../../agents/tools/persistence/tool-call-record-repo.js";
import type { HandoffMessageInput } from "./types.js";

const changedFilesSchema = z.array(z.union([z.string(), z.object({ path: z.string() })])).nullable();

/** Load full or exclusive-delta history without using the legacy messages.tool_calls column. */
export function loadHandoffMessages(input: {
  readonly messageRepo: MessageRepo;
  readonly toolCallRecordRepo: ToolCallRecordRepo;
  readonly threadId: string;
  readonly afterSequence?: number;
}): HandoffMessageInput[] {
  const selected = input.messageRepo.listIncludingInternal(input.threadId)
    .filter((row) => input.afterSequence === undefined || row.sequence > input.afterSequence);
  const toolsByMessage = input.toolCallRecordRepo.listByMessages(selected.map((row) => row.id));
  return selected.map((row) => ({
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    provider: row.provider ?? null,
    isInternal: row.is_internal ?? false,
    filesChanged: (changedFilesSchema.parse(row.files_changed) ?? []).map((file) => typeof file === "string" ? file : file.path),
    tools: (toolsByMessage.get(row.id) ?? []).map((tool) => ({
      toolName: tool.tool_name,
      inputSummary: tool.input_summary,
    })),
  }));
}
