import type { Database } from "bun:sqlite";
import * as NodeUtil from "node:util";
import { AgentThreadIdSchema, CanonicalTimestampSchema, MessageSchema, NativePlanFileRefSchema, PlanVersionSchema, lazySchema,
  type PlanVersion } from "@mcode/contracts";
import { z } from "zod";
import { ThreadStore as ThreadRepo } from "../../thread-control/persistence/thread-store.js";
import { MessageStore as MessageRepo } from "../conversation/persistence/message-store.js";
import { PlanStore as PlanRepo } from "../planning/persistence/plan-store.js";

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const boundedIdentitySchema = z.string().min(1).max(256).refine((id) => id.trim() === id,
  "Accepted feature identities must retain exact routing");
const planSchema = lazySchema(() => PlanVersionSchema().extend({
  threadId: boundedIdentitySchema, messageId: boundedIdentitySchema.nullable(),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: CanonicalTimestampSchema,
}).strict());
const threadPatchSchema = z.object({
  contextTokensUsed: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  contextWindow: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  compactSummary: z.string().max(MAX_METADATA_BYTES).optional(),
}).strict().refine((patch) => patch.contextWindow === undefined || patch.contextTokensUsed !== undefined,
  "Context window requires reported context occupancy");

/** Bounded feature metadata sent on the final write page after its accepted items materialize. */
export const AcceptedFeatureWriteMetadataSchema = lazySchema(() => z.object({
  threadPatch: threadPatchSchema.optional(),
  noticeSession: z.object({ sessionId: z.string().max(64).nullable() }).strict().optional(),
  expiredNoticeMessageIds: z.array(boundedIdentitySchema).max(8_192).readonly().optional(),
  planRecords: z.array(planSchema()).max(256).readonly().optional(),
  nativePlanFile: z.object({ planId: z.string().uuid(), ref: NativePlanFileRefSchema() }).optional(),
}).strict().superRefine(validateMetadataBounds));

/** Assigned data retained at acceptance; the worker never allocates feature identities or versions. */
export type AcceptedFeatureWriteMetadata = z.infer<ReturnType<typeof AcceptedFeatureWriteMetadataSchema>>;

/**
 * Persists assigned feature metadata atomically after canonical messages have been materialized.
 * Call only on the final page of an accepted operation, inside its worker-owned write path.
 * Explicit nullable notice selection survives serialization, including clearing the session.
 */
export function persistAcceptedFeatureWrite(db: Database, threadId: string, metadata: unknown): void {
  const routedThreadId = AgentThreadIdSchema.parse(threadId);
  if (routedThreadId !== threadId) throw new Error("Accepted feature write has an altered thread identity");
  const parsed = AcceptedFeatureWriteMetadataSchema().parse(metadata);
  const threads = new ThreadRepo(db);
  const messages = new MessageRepo(db);
  const plans = new PlanRepo(db);
  db.transaction(() => {
    if (!threads.findById(threadId)) throw new Error("Accepted feature write thread is missing");
    persistThreadPatch(threads, threadId, parsed.threadPatch);
    if (parsed.noticeSession) {
      db.prepare("UPDATE threads SET current_notice_session_id = ? WHERE id = ?").run(parsed.noticeSession.sessionId, threadId);
    }
    for (const id of parsed.expiredNoticeMessageIds ?? []) expireNotice(db, messages, threadId, id);
    for (const plan of parsed.planRecords ?? []) persistPlan(db, plans, messages, threadId, plan);
    persistNativePlanFile(db, threadId, parsed);
  })();
}

function persistNativePlanFile(db: Database, threadId: string, metadata: AcceptedFeatureWriteMetadata): void {
  const native = metadata.nativePlanFile;
  if (!native) return;
  const captured = metadata.planRecords?.find((plan) => plan.id === native.planId);
  if (captured?.author !== "agent" || captured.captureSource !== "native") throw new Error("Native plan file requires its captured agent version");
  db.prepare("UPDATE plans SET native_plan_file_json = ? WHERE id = ? AND thread_id = ?")
    .run(JSON.stringify(native.ref), captured.id, threadId);
}

function validateMetadataBounds(metadata: { readonly planRecords?: readonly PlanVersion[]; readonly expiredNoticeMessageIds?: readonly string[] },
  context: z.RefinementCtx): void {
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Accepted feature metadata exceeds its byte limit" });
  }
  const plans = metadata.planRecords ?? [];
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Accepted feature metadata repeats a plan identity" });
  }
  const expired = metadata.expiredNoticeMessageIds ?? [];
  if (new Set(expired).size !== expired.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Accepted feature metadata repeats a notice identity" });
  }
}

function persistThreadPatch(threads: ThreadRepo, threadId: string, patch: AcceptedFeatureWriteMetadata["threadPatch"]): void {
  if (!patch) return;
  if (patch.contextTokensUsed !== undefined && !threads.updateContextUsage(threadId, patch.contextTokensUsed, patch.contextWindow)) {
    throw new Error("Accepted context usage thread is missing");
  }
  if (patch.compactSummary !== undefined) threads.updateCompactSummary(threadId, patch.compactSummary);
}

function expireNotice(db: Database, messages: MessageRepo, threadId: string, id: string): void {
  const existing = messages.findByIdInThreadIncludingInternal(threadId, id);
  if (!existing) {
    if (db.prepare("SELECT 1 FROM messages WHERE id = ? AND thread_id <> ?").get(id, threadId)) {
      throw new Error("Accepted notice expiry belongs to another thread");
    }
    return;
  }
  const message = MessageSchema().parse(existing);
  if (message.role !== "system" || !message.systemNotice) throw new Error("Accepted notice expiry is not a system notice");
  db.prepare("DELETE FROM messages WHERE id = ? AND thread_id = ? AND role = 'system' AND system_notice IS NOT NULL").run(id, threadId);
}

function persistPlan(db: Database, plans: PlanRepo, messages: MessageRepo, threadId: string, plan: PlanVersion): void {
  validatePlanRouting(db, plans, messages, threadId, plan);
  const existing = plans.getById(plan.id);
  if (!existing) { plans.insert(plan); return; }
  if (existing.status === "accepted" || existing.status === "superseded") return;
  db.prepare("UPDATE plans SET status = ?, updated_at = ? WHERE id = ?").run(plan.status, plan.updatedAt, plan.id);
}

function validatePlanRouting(db: Database, plans: PlanRepo, messages: MessageRepo, threadId: string, plan: PlanVersion): void {
  if (plan.threadId !== threadId) throw new Error("Accepted plan belongs to another thread");
  const existing = plans.getById(plan.id);
  if (existing && !samePlanContent(existing, plan)) throw new Error("Accepted plan identity has conflicting content");
  if (plan.author === "user") {
    if (!existing || plan.status !== "superseded") throw new Error("Canonical capture can only supersede an existing user draft");
    return;
  }
  validateAgentPlanRouting(db, plans, messages, threadId, plan);
}

function validateAgentPlanRouting(db: Database, plans: PlanRepo, messages: MessageRepo, threadId: string, plan: PlanVersion): void {
  if (!plan.messageId) throw new Error("Agent plan requires its assistant message");
  const assistant = messages.findByIdInThreadIncludingInternal(threadId, plan.messageId);
  if (assistant?.role !== "assistant") throw new Error("Accepted plan requires its materialized assistant message");
  const existingMessagePlan = plans.getByMessageId(plan.messageId);
  if (existingMessagePlan && existingMessagePlan.id !== plan.id) throw new Error("Accepted assistant already has another plan");
  if (db.prepare("SELECT 1 FROM plans WHERE thread_id = ? AND version = ? AND id <> ?").get(threadId, plan.version, plan.id)) {
    throw new Error("Accepted plan version has conflicting identity");
  }
}

function samePlanContent(a: PlanVersion, b: PlanVersion): boolean {
  const { status: _aStatus, updatedAt: _aUpdated, ...aContent } = a;
  const { status: _bStatus, updatedAt: _bUpdated, ...bContent } = b;
  return NodeUtil.isDeepStrictEqual(aContent, bContent);
}
