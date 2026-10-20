import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import type { MessageRepo } from "../../agents/conversation/persistence/message-repo.js";
import type { ToolCallRecordRepo } from "../../agents/tools/persistence/tool-call-record-repo.js";
import { messages } from "../../../runtime/persistence/sqlite/schema.js";
import type { HandoffMessageInput } from "./types.js";

const changedFilesSchema = z.array(z.union([z.string(), z.object({ path: z.string() })])).nullable();

/** Load full or exclusive-delta history without using the legacy messages.tool_calls column. */
export function loadHandoffMessages(input: {
  readonly db: Database;
  readonly messageRepo: MessageRepo;
  readonly toolCallRecordRepo: ToolCallRecordRepo;
  readonly threadId: string;
  readonly afterSequence?: number;
}): HandoffMessageInput[] {
  // MessageRepo's public Message projection omits provider, so read provenance
  // from the same database instead of guessing it from the thread or model.
  const providers = drizzle(input.db).select({ id: messages.id, provider: messages.provider })
    .from(messages).where(eq(messages.threadId, input.threadId)).all();
  const providerById = new Map(providers.map((row) => [row.id, row.provider]));
  const rows = input.messageRepo.listIncludingInternal(input.threadId);
  const selected = rows.filter((row) => input.afterSequence === undefined || row.sequence > input.afterSequence);
  return selected.map((row) => ({
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    provider: providerById.get(row.id) ?? null,
    isInternal: row.is_internal ?? false,
    filesChanged: (changedFilesSchema.parse(row.files_changed) ?? []).map((file) => typeof file === "string" ? file : file.path),
    tools: input.toolCallRecordRepo.listByMessage(row.id).map((tool) => ({
      toolName: tool.tool_name,
      inputSummary: tool.input_summary,
    })),
  }));
}
