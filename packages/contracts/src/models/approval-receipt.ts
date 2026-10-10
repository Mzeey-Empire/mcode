import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ApprovalOriginSchema, ApprovalOutcomeSchema } from "./approval.js";

/** Bounded provider decision, published in the owning turn's event order. */
export const ApprovalDecidedPayloadSchema = lazySchema(() => z.object({
  threadId: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256),
  toolCallId: z.string().max(256).optional(),
  kind: z.enum(["command", "file_edit", "fetch", "tool", "thread_operation", "question"]),
  subjectLabel: z.string().min(1).max(200),
  outcome: ApprovalOutcomeSchema(),
  origin: ApprovalOriginSchema().optional(),
}));

/** Persisted decision carried by an approval narrative entry. */
export const ApprovalReceiptRecordSchema = lazySchema(() => z.object({
  id: z.string().min(1).max(256),
  message_id: z.string().max(256),
  tool_call_id: z.string().max(256).nullable(),
  kind: ApprovalDecidedPayloadSchema().shape.kind,
  subject_label: z.string().min(1).max(200),
  outcome: ApprovalOutcomeSchema(),
  origin: ApprovalOriginSchema().nullable(),
  decided_at: z.string().min(1).max(64),
  sort_order: z.number().int().nonnegative(),
}).strict());

/** A durable approval decision linked to its assistant message. */
export type ApprovalReceiptRecord = z.infer<ReturnType<typeof ApprovalReceiptRecordSchema>>;
