import { z } from "zod";
import { AgentItemIdSchema, AgentThreadActivityStateSchema, AgentThreadIdSchema, AgentTurnStatusSchema, CanonicalTimestampSchema, ProviderIdentitySchema, ProviderIdSchema, lazySchema, CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN, CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH, CANONICAL_SUBAGENT_TASK_MAX_LENGTH, CanonicalSubagentTerminalOutcomeSchema } from "@mcode/contracts";

/** Bounded request for the canonical descendants of one owning parent. */
export const CanonicalChildRosterRequestSchema = lazySchema(() =>
  z.object({
    owningParentThreadId: AgentThreadIdSchema,
    limit: z.number().int().min(1).max(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN + 1).default(
      CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN,
    ),
  }).strict(),
);


/** One canonical child in the authoritative Sub-agents roster. */
export const CanonicalChildRowSchema = lazySchema(() =>
  z.object({
    id: AgentThreadIdSchema,
    provider: ProviderIdSchema,
    stepCount: z.number().int().nonnegative(),
    parentThreadId: AgentThreadIdSchema,
    rootThreadId: AgentThreadIdSchema,
    owningParentThreadId: AgentThreadIdSchema,
    lineage: z.array(AgentThreadIdSchema).min(1).max(CANONICAL_SUBAGENT_LINEAGE_MAX_DEPTH),
    activityState: AgentThreadActivityStateSchema,
    latestTurnStatus: AgentTurnStatusSchema.nullable(),
    startedAt: CanonicalTimestampSchema,
    updatedAt: CanonicalTimestampSchema,
    endedAt: CanonicalTimestampSchema.nullable(),
    terminalOutcome: CanonicalSubagentTerminalOutcomeSchema.nullable(),
    /** Exact canonical source item that initiated this child, when available. */
    sourceItemId: AgentItemIdSchema.optional(),
    task: z.string().trim().min(1).max(CANONICAL_SUBAGENT_TASK_MAX_LENGTH).optional(),
    identity: z.string().trim().min(1).max(96).optional(),
    model: z.string().trim().min(1).max(128).optional(),
    reasoning: z.string().trim().min(1).max(128).optional(),
    providerIdentities: z.array(ProviderIdentitySchema).max(16),
    sourceProviderIdentities: z.array(ProviderIdentitySchema).max(16),
    hasActiveDescendant: z.boolean(),
    canStop: z.boolean(),
  }).strict(),
);

/** Canonical active and completed descendants for one owning parent. */
export const CanonicalChildRosterSchema = lazySchema(() =>
  z.object({
    owningParentThreadId: AgentThreadIdSchema,
    rosterRevision: z.number().int().nonnegative(),
    active: z.array(CanonicalChildRowSchema()).max(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN + 1),
    done: z.array(CanonicalChildRowSchema()).max(CANONICAL_SUBAGENT_ROSTER_MAX_CHILDREN + 1),
  }).strict(),
);


/** Internal canonical child query. */
export type CanonicalChildRosterRequest = z.infer<ReturnType<typeof CanonicalChildRosterRequestSchema>>;
/** Internal canonical child projection. */
export type CanonicalChildRow = z.infer<ReturnType<typeof CanonicalChildRowSchema>>;
/** Internal canonical child set. */
export type CanonicalChildRoster = z.infer<ReturnType<typeof CanonicalChildRosterSchema>>;
