import { z } from "zod";
import { MessageRoleSchema } from "./enums.js";
import { StoredAttachmentSchema } from "./attachment.js";
import { lazySchema } from "../utils/lazySchema.js";

/** Message schema matching the SQLite row shape. */
export const MessageSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    thread_id: z.string(),
    role: MessageRoleSchema,
    content: z.string(),
    tool_calls: z.unknown().nullable(),
    files_changed: z.unknown().nullable(),
    cost_usd: z.number().nullable(),
    tokens_used: z.number().nullable(),
    timestamp: z.string(),
    sequence: z.number(),
    attachments: z.array(StoredAttachmentSchema).nullable(),
    tool_call_count: z.number().optional(),
    reply_to_message_id: z.string().nullable().optional(),
    quoted_text: z.string().nullable().optional(),
  }),
);
/** Message record from the database. */
export type Message = z.infer<ReturnType<typeof MessageSchema>>;

/** Paginated message list with cursor metadata. */
export const PaginatedMessagesSchema = lazySchema(() =>
  z.object({
    messages: z.array(MessageSchema()),
    hasMore: z.boolean(),
    /**
     * IDs of assistant messages whose plan-questions block has been answered.
     * Used by the web client to suppress the plan-question wizard from
     * re-popping after restarts or mid-turn errors. Optional for backwards
     * compatibility — older servers omit it and the client falls back to the
     * structural heuristic.
     */
    answeredPlanMessageIds: z.array(z.string()).optional(),
  }),
);
/** Paginated message response from the server. */
export type PaginatedMessages = z.infer<ReturnType<typeof PaginatedMessagesSchema>>;
