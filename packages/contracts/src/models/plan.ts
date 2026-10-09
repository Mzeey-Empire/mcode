import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderIdSchema } from "./settings.js";

/** Maximum UTF-16 content length accepted for a new plan write. */
export const PLAN_MAX_CONTENT_CHARS = 64 * 1024;

/** Private provider evidence carried to persistence, never included in public versions. */
export const NativePlanFileRefSchema = lazySchema(() => z.object({
  path: z.string().min(1).max(32 * 1024),
  sessionId: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict());

/** User drafts are mutable; ready, accepted and superseded versions are immutable. */
export const PlanVersionStatusSchema = lazySchema(() =>
  z.enum(["draft", "ready", "accepted", "superseded"]),
);

/** Lifecycle state of a durable plan version. */
export type PlanVersionStatus = z.infer<ReturnType<typeof PlanVersionStatusSchema>>;

/**
 * Server-side hint for plan-tab actions sent through `agent.send`.
 * Overrides thread interaction mode so implement/revise are not re-wrapped
 * with the plan-questions prompt.
 */
export const PlanActionSchema = lazySchema(() => z.enum(["revise", "implement"]));

export type PlanAction = z.infer<ReturnType<typeof PlanActionSchema>>;

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
