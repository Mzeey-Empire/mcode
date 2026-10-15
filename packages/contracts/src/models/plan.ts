import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderIdSchema } from "./settings.js";
import { PlanPhaseSchema } from "./thread.js";
import { PlanQuestionSchema } from "./plan-questions.js";

/** Maximum UTF-16 content length accepted for a new plan write. */
export const PLAN_MAX_CONTENT_CHARS = 64 * 1024;

/** Source offsets use UTF-16 code units, matching editor positions. */
export const PlanCommentAnchorSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    end: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), quote: z.string().min(1).max(2000),
    prefix: z.string().max(64), suffix: z.string().max(64), section: z.string().max(200).nullable() }),
  z.object({ kind: z.literal("section"), section: z.string().max(200).nullable(), quote: z.string().max(2000) }),
]).refine(anchor => anchor.kind === "section" || anchor.end - anchor.start === anchor.quote.length, "Invalid comment range"));

/** Validated text selection or section fallback. */
export type PlanCommentAnchor = z.infer<ReturnType<typeof PlanCommentAnchorSchema>>;

/** Durable comment belonging to one plan version. */
export const PlanCommentSchema = lazySchema(() => z.object({
  id: z.string().uuid(), threadId: z.string().min(1).max(256), versionId: z.string().uuid(),
  body: z.string().max(4000).trim().min(1), anchor: PlanCommentAnchorSchema(),
  status: z.enum(["open", "resolved"]), sentMessageId: z.string().max(256).nullable(),
  carriedFromCommentId: z.string().uuid().nullable(), createdAt: z.string().max(64),
  updatedAt: z.string().max(64), resolvedAt: z.string().max(64).nullable(),
}));

/** Validated persisted plan comment. */
export type PlanComment = z.infer<ReturnType<typeof PlanCommentSchema>>;

/** Unsaved composer editor, including an empty note while typing. */
export const PlanCommentEditorDraftSchema = lazySchema(() => z.object({
  planVersionId: z.string().uuid(), commentId: z.string().uuid().nullable(),
  anchor: PlanCommentAnchorSchema(), body: z.string().max(4000),
}));

/** Persisted composer editor state. */
export type PlanCommentEditorDraft = z.infer<ReturnType<typeof PlanCommentEditorDraftSchema>>;

/** Client-assigned identity makes comment creation replayable. */
export const PlanCommentCreateSchema = lazySchema(() => z.object({
  commentId: z.string().uuid(), versionId: z.string().uuid(), anchor: PlanCommentAnchorSchema(),
  body: z.string().max(4000).trim().min(1),
}));
/** Replace the note without changing its selection. */
export const PlanCommentUpdateSchema = lazySchema(() => z.object({
  commentId: z.string().uuid(), body: z.string().max(4000).trim().min(1),
}));
/** Resolve or reopen a saved comment. */
export const PlanCommentSetStatusSchema = lazySchema(() => z.object({
  commentId: z.string().uuid(), status: z.enum(["open", "resolved"]),
}));
/** Idempotent deletion by saved identity. */
export const PlanCommentDeleteSchema = lazySchema(() => z.object({ commentId: z.string().uuid() }));
/** Parameters of `plan.comment.create`. */
export type PlanCommentCreate = z.infer<ReturnType<typeof PlanCommentCreateSchema>>;
/** Parameters of `plan.comment.update`. */
export type PlanCommentUpdate = z.infer<ReturnType<typeof PlanCommentUpdateSchema>>;
/** Parameters of `plan.comment.setStatus`. */
export type PlanCommentSetStatus = z.infer<ReturnType<typeof PlanCommentSetStatusSchema>>;
/** Parameters of `plan.comment.delete`. */
export type PlanCommentDelete = z.infer<ReturnType<typeof PlanCommentDeleteSchema>>;
/** Frozen selection of comments riding one send. */
export const PlanCommentIdsSchema = lazySchema(() => z.array(z.string().uuid()).max(128));
/** Comment mutations and admission preserve these codes across writer and RPC boundaries. */
export const PlanCommentErrorSchema = lazySchema(() => z.object({
  code: z.enum(["plan_comment_invalid", "plan_read_only", "plan_busy"]),
}));
/** Comment operation failure. */
export type PlanCommentError = z.infer<ReturnType<typeof PlanCommentErrorSchema>>;

/** Private provider evidence carried to persistence, never included in public versions. */
export const NativePlanFileRefSchema = lazySchema(() => z.object({
  path: z.string().min(1).max(32 * 1024),
  sessionId: z.string().min(1).max(1024),
  root: z.string().min(1).max(32 * 1024).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict());

/** User drafts are mutable; ready, accepted and superseded versions are immutable. */
export const PlanVersionStatusSchema = lazySchema(() =>
  z.enum(["draft", "ready", "accepted", "superseded"]),
);

/** Lifecycle state of a durable plan version. */
export type PlanVersionStatus = z.infer<ReturnType<typeof PlanVersionStatusSchema>>;

/** Public durable plan version; provider-owned file paths stay on the server. */
export const PlanVersionSchema = lazySchema(() =>
  z.object({
    id: z.string().uuid(),
    threadId: z.string(),
    messageId: z.string().nullable(),
    version: z.number().int().min(1),
    title: z.string().min(1).max(200),
    contentMd: z.string(),
    status: PlanVersionStatusSchema(),
    author: z.enum(["agent", "user"]),
    providerId: ProviderIdSchema.nullable(),
    captureSource: z.enum(["native", "fence", "edit", "copy"]),
    baseVersionId: z.string().uuid().nullable(),
    revision: z.number().int().min(0),
    createdAt: z.string(),
    updatedAt: z.string(),
    acceptedAt: z.string().nullable(),
    acceptedMessageId: z.string().nullable(),
  }),
);

/** Validated public plan version. */
export type PlanVersion = z.infer<ReturnType<typeof PlanVersionSchema>>;

/** Stored question identity and content needed to restore an unanswered dock. */
export const PendingPlanQuestionsSchema = lazySchema(() => z.object({
  assistantMessageId: z.string(), questions: z.array(PlanQuestionSchema()).min(1).max(15),
}));

/** Implement reserved on the source while its target waits for Setup. */
export const PendingPlanImplementSchema = lazySchema(() => z.object({
  targetThreadId: z.string(), version: z.number().int().min(1),
}));

/** Source reservation presented to every client viewing the plan. */
export type PendingPlanImplement = z.infer<ReturnType<typeof PendingPlanImplementSchema>>;

/** Durable planning state returned when opening or reloading a thread. */
export const PlanSnapshotSchema = lazySchema(() => z.object({
  versions: z.array(PlanVersionSchema()), comments: z.array(PlanCommentSchema()), phase: PlanPhaseSchema.nullable(),
  pendingQuestions: PendingPlanQuestionsSchema().nullable(),
  pendingImplement: PendingPlanImplementSchema().nullable(),
}));

/** Durable planning state returned when opening or reloading a thread. */
export type PlanSnapshot = z.infer<ReturnType<typeof PlanSnapshotSchema>>;

/** Revision precondition shared by the RPC boundary and sole database writer. */
export const PlanSaveVersionSchema = lazySchema(() => z.object({
  threadId: z.string(),
  versionId: z.string().uuid(),
  baseVersionId: z.string().uuid(),
  baseRevision: z.number().int().min(0),
  contentMd: z.string().max(PLAN_MAX_CONTENT_CHARS),
}));

/** A keyed fork or an autosave of the current draft. */
export type PlanSaveVersion = z.infer<ReturnType<typeof PlanSaveVersionSchema>>;

/** Save failures retain the latest version so clients can resolve conflicts explicitly. */
export const PlanSaveErrorSchema = lazySchema(() => z.object({
  code: z.enum(["plan_busy", "plan_read_only", "plan_conflict", "thread_not_found"]),
  latestVersion: PlanVersionSchema().nullable(),
}));

/** Typed plan save failure data. */
export type PlanSaveError = z.infer<ReturnType<typeof PlanSaveErrorSchema>>;

/** Result of reconciling a provider-owned plan file before implementation. */
export const NativePlanFileOutcomeSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({ outcome: z.enum(["synced", "deleted"]) }),
    z.object({ outcome: z.literal("skipped"), reason: z.enum(["no-file", "unproven", "changed", "unsafe-path"]) }),
  ]),
);

/** Provider plan-file reconciliation result; paths never cross the client boundary. */
export type NativePlanFileOutcome = z.infer<ReturnType<typeof NativePlanFileOutcomeSchema>>;

/** Target identities retained by durable Implement requests. */
export const PlanImplementTargetSchema = lazySchema(() => z.enum(["thread", "new-thread", "new-worktree"]));

/** Implement the displayed revision, optionally saving its last edit atomically. */
export const PlanImplementSchema = lazySchema(() => z.object({
  requestId: z.string().uuid(),
  threadId: z.string(),
  versionId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  pending: PlanSaveVersionSchema().omit({ threadId: true }).optional(),
  target: PlanImplementTargetSchema(),
}).refine(input => !input.pending || input.pending.versionId === input.versionId, {
  message: "Pending version must match the implemented version", path: ["pending", "versionId"],
}));

/** Validated Implement command. */
export type PlanImplement = z.infer<ReturnType<typeof PlanImplementSchema>>;

/** Durable admission identity returned on every successful replay. */
export const PlanImplementReceiptSchema = lazySchema(() => z.object({
  requestId: z.string().uuid(), versionId: z.string().uuid(), version: z.number().int().min(1),
  targetThreadId: z.string(), messageId: z.string().uuid(),
  nativePlanFile: NativePlanFileOutcomeSchema().nullable(), state: z.enum(["admitted", "waiting-for-setup"]),
}));

/** Implement admission receipt. */
export type PlanImplementReceipt = z.infer<ReturnType<typeof PlanImplementReceiptSchema>>;

/** Typed failures preserve the current version for explicit conflict resolution. */
export const PlanImplementErrorSchema = lazySchema(() => z.object({
  code: z.enum(["thread_busy", "plan_busy", "plan_read_only", "plan_conflict",
    "implement_request_conflict", "implement_interrupted", "implement_failed", "startup_cancelled"]),
  latestVersion: PlanVersionSchema().nullable(),
}));

/** Rejected Implement command. */
export type PlanImplementError = z.infer<ReturnType<typeof PlanImplementErrorSchema>>;
