import { z } from "zod";

import { TurnOutcomeSchema } from "../models/turn-outcome.js";
import { AgentEventSchema, type AgentEvent } from "./agent-event.js";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderIdentitySchema } from "../compat/agent-model.js";
import { NativePlanFileRefSchema, PLAN_MAX_CONTENT_CHARS } from "../models/plan.js";
import { ProviderIdSchema } from "../models/settings.js";

/** Native Codex evidence used to route a private child interaction. */
export const CodexChildEvidenceSchema = lazySchema(() => z
  .object({
    nativeThreadId: z.string().trim().min(1).max(512),
    nativeTurnId: z.string().trim().min(1).max(512).optional(),
    parentCollaborationItemId: z.string().trim().min(1).max(512),
    prompt: z.string().max(32_768).optional(),
    nativeEventId: z.string().trim().min(1).max(1_024).optional(),
    nativeItemId: z.string().trim().min(1).max(512).optional(),
    itemEventKey: z.string().trim().min(1).max(512).optional(),
    outcome: TurnOutcomeSchema.optional(),
  })
  .strict());

/** Native Codex evidence that links a receiver turn to its collaboration action. */
export const CodexContinuationEvidenceSchema = lazySchema(() => z
  .object({
    sourceNativeThreadId: z.string().trim().min(1).max(512),
    sourceNativeTurnId: z.string().trim().min(1).max(512),
    sourceNativeItemId: z.string().trim().min(1).max(512),
    targetNativeThreadId: z.string().trim().min(1).max(512),
  })
  .strict());

/** Native Codex collaboration input that has no renderer-facing meaning. */
export const CodexCollaborationEvidenceSchema = lazySchema(() => z
  .object({
    kind: z.string().trim().min(1).max(128),
    senderThreadId: z.string().trim().min(1).max(512).optional(),
    receiverThreadIds: z.array(z.string().trim().min(1).max(512)).max(32).optional(),
    prompt: z.string().max(32_768).optional(),
    agentName: z.string().trim().min(1).max(512).optional(),
    agentPath: z.string().trim().min(1).max(2_048).optional(),
    model: z.string().trim().min(1).max(512).optional(),
    reasoningEffort: z.string().trim().min(1).max(512).optional(),
  })
  .strict());

/** Native Codex collaboration evidence, retained outside the renderer contract. */
export const CodexCollaborationExtensionSchema = lazySchema(() => z
  .object({
    providerId: z.literal("codex"),
    kind: z.literal("codex-collaboration"),
    child: CodexChildEvidenceSchema().optional(),
    continuation: CodexContinuationEvidenceSchema().optional(),
    collaboration: CodexCollaborationEvidenceSchema().optional(),
  })
  .strict()
  .refine(
    (extension) => extension.child !== undefined
      || extension.continuation !== undefined
      || extension.collaboration !== undefined,
    "A provider runtime extension must carry native evidence",
  ));

const NativeItemIdSchema = z.string().trim().min(1).max(512);

/** Native delegation item ids from the root to the child owner. */
export const ChildThreadPathSchema = lazySchema(() => z.array(NativeItemIdSchema).min(1).max(8));

/** Evidence for a delegation or an event owned by its child thread. */
export const ChildThreadEvidenceSchema = lazySchema(() => z.discriminatedUnion("role", [
  z.object({
    role: z.literal("delegate"),
    path: ChildThreadPathSchema(),
    prompt: z.string().max(32_768),
    title: z.string().trim().min(1).max(512).optional(),
    agentType: z.string().trim().min(1).max(512).optional(),
  }).strict(),
  z.object({
    role: z.literal("child"),
    path: ChildThreadPathSchema(),
    nativeItemId: NativeItemIdSchema.optional(),
    final: z.literal(true).optional(),
  }).strict(),
]));

/** Provider-neutral child routing evidence checked against the emitting provider. */
export const ChildThreadExtensionSchema = lazySchema(() => z.object({
  providerId: ProviderIdSchema,
  kind: z.literal("child-thread"),
  childThread: ChildThreadEvidenceSchema(),
}).strict());

/** Provider evidence dispatched by kind before generic event handling. */
export const ProviderRuntimeExtensionSchema = lazySchema(() => z.union([
  CodexCollaborationExtensionSchema(),
  ChildThreadExtensionSchema(),
]));

/** Distinguishes absent evidence, an explicit root, and an exact native parent. */
export const ProviderParentEvidenceSchema = lazySchema(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("root") }).strict(),
  z.object({ kind: z.literal("native"), identity: ProviderIdentitySchema.extend({ scope: z.literal("parentItem"), provenance: z.literal("native") }) }).strict(),
]));

/** Exact source parent evidence retained until canonical attribution interprets it. */
export type ProviderParentEvidence = z.infer<ReturnType<typeof ProviderParentEvidenceSchema>>;

/** Provider-emitted event that keeps native evidence outside the renderer contract. */
export const ProviderRuntimeEventSchema = lazySchema(() =>
  z.object({
    event: AgentEventSchema(),
    deliveryAttempt: z.number().int().positive().optional(),
    extension: ProviderRuntimeExtensionSchema().optional(),
    parentEvidence: ProviderParentEvidenceSchema().optional(),
    /** Private capture evidence bound to the assistant message that materializes it. */
    planCapture: z.object({
      markdown: z.string().min(1).max(PLAN_MAX_CONTENT_CHARS),
      source: z.enum(["native", "fence"]),
      nativePlanFile: NativePlanFileRefSchema().optional(),
    }).strict().optional(),
  }).strict().refine(validChildThreadPairing, "Child-thread evidence must match its event"),
);

function validChildThreadPairing(runtime: { event: AgentEvent; extension?: ProviderRuntimeExtension }): boolean {
  if (runtime.extension?.kind !== "child-thread") return true;
  const { event } = runtime;
  const evidence = runtime.extension.childThread;
  if (evidence.role === "delegate") {
    return event.type === "toolUse" && event.toolName === "Agent"
      && event.toolCallId === evidence.path.at(-1) && event.parentToolCallId === undefined;
  }
  return validChildObservation(event, evidence);
}

function validChildObservation(event: AgentEvent, evidence: Extract<ChildThreadEvidence, { role: "child" }>): boolean {
  if (evidence.final && event.type !== "textDelta") return false;
  switch (event.type) {
    case "textDelta": return evidence.nativeItemId !== undefined;
    case "toolUse":
    case "toolResult": return event.parentToolCallId === undefined;
    case "turnComplete":
    case "error":
    case "ended": return true;
    default: return false;
  }
}

/** Provider-emitted event that keeps native evidence outside the renderer contract. */
export type ProviderRuntimeEvent = z.infer<ReturnType<typeof ProviderRuntimeEventSchema>>;

/** Native Codex evidence used to route a private child interaction. */
export type CodexChildEvidence = z.infer<ReturnType<typeof CodexChildEvidenceSchema>>;
/** Native Codex evidence that links a receiver turn to its collaboration action. */
export type CodexContinuationEvidence = z.infer<ReturnType<typeof CodexContinuationEvidenceSchema>>;
/** Native Codex collaboration input that has no renderer-facing meaning. */
export type CodexCollaborationEvidence = z.infer<ReturnType<typeof CodexCollaborationEvidenceSchema>>;
/** Provider-native evidence attached to a generic event until an adapter interprets it. */
export type ProviderRuntimeExtension = z.infer<ReturnType<typeof ProviderRuntimeExtensionSchema>>;

/** Dispatch key for provider runtime evidence. */
export type ProviderRuntimeExtensionKind = ProviderRuntimeExtension["kind"];
/** Native Codex collaboration extension. */
export type CodexCollaborationExtension = z.infer<ReturnType<typeof CodexCollaborationExtensionSchema>>;
/** Provider-neutral delegation or child observation. */
export type ChildThreadEvidence = z.infer<ReturnType<typeof ChildThreadEvidenceSchema>>;

/** Wrap a generic event with optional provider evidence. */
export function providerRuntimeEvent(event: AgentEvent, extension?: ProviderRuntimeExtension): ProviderRuntimeEvent {
  return { event, ...(extension ? { extension } : {}) };
}

/** Resolve Codex evidence without interpreting another extension kind. */
export function codexCollaborationExtension(extension: ProviderRuntimeExtension | undefined): CodexCollaborationExtension | undefined {
  return extension?.kind === "codex-collaboration" ? extension : undefined;
}

/** Whether an observation must bypass parent reducers, buffers, and terminal detection. */
export function isChildRoutedRuntimeEvent(extension: ProviderRuntimeExtension | undefined): boolean {
  switch (extension?.kind) {
    case "codex-collaboration": return Boolean(extension.child || extension.continuation);
    case "child-thread": return extension.childThread.role === "child";
    case undefined: return false;
  }
}
