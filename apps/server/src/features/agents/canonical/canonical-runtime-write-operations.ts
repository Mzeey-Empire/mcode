import { z } from "zod";
import { AgentItemSchema, AgentThreadSchema, AgentTurnSchema, CanonicalAgentEventEnvelopeSchema, CollaborationActionSchema, ProviderIdentitySchema, InterruptionCauseSchema } from "@mcode/contracts/compat/agent-model";
import { TurnOutcomeSchema } from "@mcode/contracts/models/turn-outcome";
import { databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";

const committedPublications = z.object({ events: z.array(CanonicalAgentEventEnvelopeSchema) });
function runtimeOperation<Input, Output>(name: string, input: z.ZodType<Input, z.ZodTypeDef, unknown>,
  result: z.ZodType<Output, z.ZodTypeDef, unknown>) {
  return databaseWriteOperation(name, input, committedPublications.extend({ result }));
}

const identity = z.string().min(1);
const childIdentity = z.object({ parentThreadId: identity, parentTurnId: identity,
  parentExecutionId: identity, parentItemId: identity, nativeThreadId: identity });
const delegation = z.object({ parentThreadId: identity, parentTurnId: identity,
  parentExecutionId: identity, parentItemId: identity, receiverThreadIds: z.array(identity).optional(),
  description: z.string().optional(), prompt: z.string().optional(), identity: z.string().optional(),
  model: z.string().optional(), reasoningEffort: z.string().optional(), replacementForActionId: identity.optional(),
  providerIdentities: z.array(ProviderIdentitySchema) });
const delegationResult = z.object({ childThread: AgentThreadSchema, parentItem: AgentItemSchema,
  collaborationAction: CollaborationActionSchema });
const childFinish = z.object({ childThreadId: identity, nativeTurnId: identity,
  outcome: TurnOutcomeSchema, error: z.string().optional() });

/** Validated commit metadata released to main only after the outer command commits. */
export const CanonicalRuntimeCommitResultSchema = z.object({
  outcome: z.enum(["committed", "duplicate", "conflict", "terminal-outcome-confirmed", "ingest-overflow"]),
  canonicalDelivery: z.enum(["published", "deferred", "not-required"]).optional(),
  conversationRevision: z.number().int().nonnegative(), rosterRevision: z.number().int().nonnegative(),
  acceptedThrough: z.number().int().nonnegative(), durableThrough: z.number().int().nonnegative(),
  events: z.array(CanonicalAgentEventEnvelopeSchema),
});

/** Main runtime mutations whose complete transaction executes on the writer connection. */
export const canonicalRuntimeWriteOperations = {
  interruptLostExecution: runtimeOperation("canonical.interruptLostExecution", z.object({
    threadId: identity, turnId: identity, executionId: identity, reason: z.string(), cause: InterruptionCauseSchema,
    recoveryIncidentId: identity, assignedMessageId: identity.optional(), endedAt: z.string().datetime().optional(),
  }), CanonicalRuntimeCommitResultSchema),
  reopenUnmaterializedTerminalCheckpoint: runtimeOperation("canonical.reopenUnmaterializedTerminalCheckpoint", z.tuple([identity]), z.boolean()),
  recordNativeCursor: runtimeOperation("canonical.recordNativeCursor", z.tuple([identity, ProviderIdentitySchema]), z.boolean()),
  interruptSavedFamilyChildren: runtimeOperation("canonical.interruptSavedFamilyChildren", z.tuple([z.string()]), z.array(identity)),
  interruptSubagentTurns: runtimeOperation("canonical.interruptSubagentTurns", z.tuple([z.array(identity), z.string()]), z.literal(true)),
  finishSubagentTurn: runtimeOperation("canonical.finishSubagentTurn", childFinish.extend({ outcome: z.literal("interrupted"), error: z.string() }), AgentTurnSchema),
  recordCollaborationAction: runtimeOperation("canonical.recordCollaborationAction", z.object({
    actionId: identity, kind: CollaborationActionSchema.shape.kind, sourceThreadId: identity,
    sourceTurnId: identity, sourceExecutionId: identity, sourceItemId: identity, targetThreadId: identity,
    targetTurnId: identity.optional(), status: CollaborationActionSchema.shape.status,
    providerIdentities: z.array(ProviderIdentitySchema), payload: z.record(z.string(), z.unknown()),
  }), CollaborationActionSchema),
  startCodexChildDelegation: runtimeOperation("canonical.startCodexChildDelegation", delegation, delegationResult),
  markCodexChildDeliveryUnknown: runtimeOperation("canonical.markCodexChildDeliveryUnknown", childIdentity, delegationResult),
  markCodexChildDeliveryRejected: runtimeOperation("canonical.markCodexChildDeliveryRejected", childIdentity, delegationResult),
  markUnresolvedCodexChildDeliveriesUnknown: runtimeOperation("canonical.markUnresolvedCodexChildDeliveriesUnknown", z.tuple([identity]), z.array(identity)),
  retryCodexChildDelegation: runtimeOperation("canonical.retryCodexChildDelegation", delegation.omit({ replacementForActionId: true }).extend({ previousActionId: identity }), delegationResult),
  registerCodexReceiverThreadIds: runtimeOperation("canonical.registerCodexReceiverThreadIds", childIdentity.extend({ receiverThreadIds: z.array(identity) }), delegationResult),
  bindCodexChildIdentity: runtimeOperation("canonical.bindCodexChildIdentity", childIdentity, delegationResult),
  startCodexChildTurn: runtimeOperation("canonical.startCodexChildTurn", childIdentity.extend({ nativeTurnId: identity, prompt: z.string().optional(), triggerActionId: identity.optional() }), AgentTurnSchema),
  recordCodexChildItem: runtimeOperation("canonical.recordCodexChildItem", z.object({ childThreadId: identity,
    nativeTurnId: identity, nativeItemId: identity, eventKey: identity, kind: AgentItemSchema.shape.kind,
    payload: z.record(z.string(), z.unknown()), parentItemId: identity.optional() }), AgentItemSchema),
  finishCodexChildTurn: runtimeOperation("canonical.finishCodexChildTurn", childFinish, AgentTurnSchema),
  finishCanonicalChildTurn: runtimeOperation("canonical.finishCanonicalChildTurn", childFinish.omit({ nativeTurnId: true }), AgentTurnSchema.nullable()),
  recordCodexChildRoutingDiagnostic: runtimeOperation("canonical.recordCodexChildRoutingDiagnostic", z.object({
    threadId: identity, parentItemId: identity.optional(), executionId: identity.optional(), event: z.unknown(), reason: z.string(),
  }).transform((value) => ({ ...value, event: value.event })), z.boolean()),
};
