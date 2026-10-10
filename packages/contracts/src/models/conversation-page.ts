import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageSchema, SessionNoticesSchema, type Message } from "./message.js";
import { ToolCallRecordSchema, type ToolCallRecord } from "./tool-call-record.js";
import { ThoughtSegmentRecordSchema, type ThoughtSegmentRecord } from "./thought-segment.js";
import { HookExecutionRecordSchema, type HookExecutionRecord } from "./hook-execution.js";
import { ApprovalReceiptRecordSchema, type ApprovalReceiptRecord } from "./approval-receipt.js";

/** Persisted narrative records grouped under one assistant message. */
// The explicit type keeps WS_METHODS under the compiler's declaration size limit.
export const ConversationNarrativeBatchSchema = lazySchema<z.ZodType<ConversationNarrativeBatch>>(() =>
  z.object({
    tools: z.array(ToolCallRecordSchema()),
    thoughts: z.array(ThoughtSegmentRecordSchema()),
    hooks: z.array(HookExecutionRecordSchema()),
    approvals: z.array(ApprovalReceiptRecordSchema()),
  }),
);

/** Thread conversation page: messages plus their grouped narrative payloads. */
export const ConversationPageSchema = lazySchema<z.ZodType<ConversationPage>>(() =>
  z.object({
    messages: z.array(MessageSchema()),
    sessionNotices: SessionNoticesSchema().optional(),
    hasMore: z.boolean(),
    answeredPlanMessageIds: z.array(z.string()).optional(),
    narrativeByMessage: z.record(ConversationNarrativeBatchSchema()),
  }),
);

/** Persisted narrative records grouped under one assistant message. */
export interface ConversationNarrativeBatch {
  tools: ToolCallRecord[];
  thoughts: ThoughtSegmentRecord[];
  hooks: HookExecutionRecord[];
  approvals: ApprovalReceiptRecord[];
}

/** Thread conversation page returned by `conversation.page`. */
export interface ConversationPage {
  messages: Message[];
  sessionNotices?: Message[];
  hasMore: boolean;
  answeredPlanMessageIds?: string[];
  narrativeByMessage: Record<string, ConversationNarrativeBatch>;
}
