import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderIdSchema } from "./settings.js";
import { THREAD_SEND_MESSAGE_MAX_LENGTH } from "../thread-control.js";

/** A provider-offered answer whose label is also its native reply identity. */
export const ApprovalQuestionOptionSchema = lazySchema(() => z.object({
  label: z.string().min(1).max(100).refine((label) => label.trim().length > 0),
  description: z.string().min(1).max(500).optional(),
}).strict());
/** One question carried by an approval. */
export const ApprovalQuestionSchema = lazySchema(() => z.object({
  header: z.string().min(1).max(200), question: z.string().min(1).max(1_000),
  options: z.array(ApprovalQuestionOptionSchema()).max(10),
  multiple: z.boolean(), custom: z.boolean(),
}).strict());
/** Ordered answers using exact provider labels. */
export const ApprovalAnswersSchema = lazySchema(() => z.array(
  z.array(z.string().min(1).max(100).refine((answer) => answer.trim().length > 0)).min(1).max(10),
).min(1).max(10));
/** File scope and optional display-only patch. */
export const ApprovalFilePatchSchema = lazySchema(() => z.object({
  path: z.string().min(1).max(4_096),
  change: z.enum(["edited", "added", "removed", "renamed"]),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  patch: z.string().max(262_144).optional(), patchTruncated: z.boolean().optional(),
}).strict());
/** Complete scope of the operation being authorized. */
export const ApprovalSubjectSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: z.string().min(1).max(65_536),
    cwd: z.string().max(4_096).optional(), facts: z.array(z.string().min(1).max(80)).max(4).optional() }).strict(),
  z.object({ kind: z.literal("file_edit"), files: z.array(ApprovalFilePatchSchema()).min(1).max(256) }).strict(),
  z.object({ kind: z.literal("fetch"), url: z.string().min(1).max(8_192) }).strict(),
  z.object({ kind: z.literal("tool"), toolName: z.string().min(1).max(200), preview: z.string().max(65_536).optional() }).strict(),
  z.object({ kind: z.literal("thread_operation"), operation: z.enum(["thread_create_batch", "thread_send", "thread_stop"]),
    targetThreadId: z.string(), targetTitle: z.string().max(200).optional(), message: z.string().max(THREAD_SEND_MESSAGE_MAX_LENGTH).optional() }).strict(),
  z.object({ kind: z.literal("question"), questions: z.array(ApprovalQuestionSchema()).min(1).max(10) }).strict(),
]));
/** Meaning of an adapter-owned choice, independent of its label. */
export const ApprovalChoiceIntentSchema = z.enum(["allow_once", "allow_scoped", "deny", "provider"]);
/** Exact choice identity and the whole scope or consequence it grants. */
export const ApprovalChoiceSchema = lazySchema(() => z.object({
  id: z.string().min(1).max(200), intent: ApprovalChoiceIntentSchema,
  label: z.string().min(1).max(200), description: z.string().min(1).max(500).optional(),
}).strict());
/** Identity of the actor requesting approval. */
export const ApprovalOriginSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.literal("subagent"), label: z.string().min(1).max(200), parentToolCallId: z.string().max(256).optional() }).strict(),
  z.object({ kind: z.literal("integration"), label: z.string().min(1).max(200) }).strict(),
]));
const approvalRequestBodyObject = lazySchema(() => z.object({
  toolCallId: z.string().max(256).optional(), requestedAt: z.string(), reason: z.string().max(1_000).optional(),
  subject: ApprovalSubjectSchema(), choices: z.array(ApprovalChoiceSchema()).min(1).max(10),
  noteDelivery: z.enum(["native", "steer", "next_turn", "none"]), noteChoiceId: z.string().min(1).max(200).optional(),
  origin: ApprovalOriginSchema(),
}).strict());

function denyChoicesAndNoteChoice(body: z.infer<ReturnType<typeof approvalRequestBodyObject>>, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  for (const [index, choice] of body.choices.entries()) {
    if (ids.has(choice.id)) ctx.addIssue({ code: "custom", path: ["choices", index, "id"], message: "Choice ids must be unique" });
    ids.add(choice.id);
  }
  if (body.subject.kind !== "question" && !body.choices.some((choice) => choice.intent === "deny")) {
    ctx.addIssue({ code: "custom", path: ["choices"], message: "A deny choice is required" });
  }
  if (body.noteDelivery !== "none" && !body.choices.some((choice) => choice.id === body.noteChoiceId && choice.intent === "deny")) {
    ctx.addIssue({ code: "custom", path: ["noteChoiceId"], message: "Notes require a deny choice" });
  }
}

/** Untrusted adapter display data, including decision safety invariants. */
export const ApprovalRequestBodySchema = lazySchema(() => approvalRequestBodyObject().superRefine(denyChoicesAndNoteChoice));
/** Validated client request with routing identity supplied by the adapter. */
export const ApprovalRequestSchema = lazySchema(() => approvalRequestBodyObject().extend({
  requestId: z.string().min(1).max(256), threadId: z.string().min(1), providerId: ProviderIdSchema.nullable(),
}).strict().superRefine(denyChoicesAndNoteChoice).superRefine((request, ctx) => {
  if (request.providerId === null && request.origin.kind !== "integration") {
    ctx.addIssue({ code: "custom", path: ["providerId"], message: "Only integrations can omit provider identity" });
  }
}));
/** The acknowledged result of an approval. */
export const ApprovalOutcomeSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("allowed"), intent: z.enum(["allow_once", "allow_scoped", "provider"]), choiceLabel: z.string().max(200) }),
  z.object({ status: z.literal("denied"), choiceLabel: z.string().max(200), note: z.string().max(4_000).optional(), noteDelivery: z.enum(["native", "steer", "next_turn"]).optional() }),
  z.object({ status: z.literal("answered"), count: z.number().int().min(1) }),
  z.object({ status: z.literal("cancelled"), reason: z.enum(["session_stopped", "turn_ended", "unanswerable"]) }),
  z.object({ status: z.literal("auto_denied"), reason: z.enum(["unreadable", "too_large"]) }),
]));
/** User response keyed by the exact advertised choice. */
export const ApprovalResponseSchema = lazySchema(() => z.object({
  choiceId: z.string().min(1).max(200), note: z.string().trim().min(1).max(4_000).optional(), answers: ApprovalAnswersSchema().optional(),
}));
/** Delivery result returned after the provider acknowledges its native answer. */
export const ApprovalRespondResultSchema = lazySchema(() => z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), noteDelivery: z.enum(["native", "steer", "next_turn", "unknown"]).optional() }),
  z.object({ status: z.literal("not_pending"), note: z.enum(["queued", "delivery_unknown"]).optional() }),
  z.object({ status: z.literal("failed"), message: z.string().max(500) }),
]));
/** Routing identity is separate from untrusted display data. */
export interface ApprovalRequestEnvelope { readonly requestId: string; readonly threadId: string; readonly body: unknown }
/** Validated approval body. */
export type ApprovalRequestBody = z.infer<ReturnType<typeof ApprovalRequestBodySchema>>;
/** Client approval request. */
export type ApprovalRequest = z.infer<ReturnType<typeof ApprovalRequestSchema>>;
/** Exact adapter choice. */
export type ApprovalChoice = z.infer<ReturnType<typeof ApprovalChoiceSchema>>;
/** Typed authorization scope. */
export type ApprovalSubject = z.infer<ReturnType<typeof ApprovalSubjectSchema>>;
/** Acknowledged decision. */
export type ApprovalOutcome = z.infer<ReturnType<typeof ApprovalOutcomeSchema>>;
/** User decision or fail-closed instruction. */
export type ApprovalResponse = z.infer<ReturnType<typeof ApprovalResponseSchema>> | { autoDeny: "unreadable" | "too_large" };
/** Native answer delivery status. */
export type ApprovalRespondResult = z.infer<ReturnType<typeof ApprovalRespondResultSchema>>;
/** Ordered answers. */
export type ApprovalAnswers = z.infer<ReturnType<typeof ApprovalAnswersSchema>>;
/** Provider question. */
export type ApprovalQuestion = z.infer<ReturnType<typeof ApprovalQuestionSchema>>;
/** Provider question option. */
export type ApprovalQuestionOption = z.infer<ReturnType<typeof ApprovalQuestionOptionSchema>>;
