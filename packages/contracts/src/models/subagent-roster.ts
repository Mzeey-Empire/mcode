import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderIdSchema } from "./settings.js";

/** One normalized subagent outcome shared by every surface. */
export const SubagentStatusSchema = z.enum(["running", "done", "failed", "stopped"]);
/** One normalized subagent outcome shared by every surface. */
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;
/** Detail supported by this entry's persisted evidence. */
export const SubagentDetailTierSchema = z.enum(["transcript", "steps", "meta"]);
/** Detail supported by this entry's persisted evidence. */
export type SubagentDetailTier = z.infer<typeof SubagentDetailTierSchema>;

/** Stable server projection of one delegated Agent call or canonical child. */
export const SubagentRosterEntrySchema = lazySchema(() => z.object({
  id: z.string().min(1),
  provider: ProviderIdSchema,
  title: z.string(),
  prompt: z.string().nullable(),
  subagentType: z.string().nullable(),
  model: z.string().nullable(),
  stepCount: z.number().int().nonnegative(),
  status: SubagentStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  tier: SubagentDetailTierSchema,
  canStop: z.boolean(),
  sourceToolCallId: z.string().nullable(),
  childThreadId: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  parentEntryId: z.string().nullable(),
}).strict());
/** Stable server projection of one delegated Agent call or canonical child. */
export type SubagentRosterEntry = z.infer<ReturnType<typeof SubagentRosterEntrySchema>>;

/** One parent roster, ordered running first and newest first within each group. */
export const SubagentRosterSchema = lazySchema(() => z.object({
  owningParentThreadId: z.string().min(1),
  epoch: z.string().min(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(SubagentRosterEntrySchema()).max(256),
  truncated: z.boolean(),
}).strict());
/** One parent roster with boot-scoped revision ordering. */
export type SubagentRoster = z.infer<ReturnType<typeof SubagentRosterSchema>>;

/** Last 32 persisted steps and the Agent's result summary. */
export const SubagentDetailSchema = lazySchema(() => z.object({
  entryId: z.string().min(1),
  steps: z.array(z.object({
    toolCallId: z.string(), toolName: z.string(), label: z.string(),
    status: z.enum(["running", "done", "failed"]),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
  }).strict()).max(32),
  totalSteps: z.number().int().nonnegative(),
  summary: z.string().nullable(),
}).strict());
/** Last 32 persisted steps and the Agent's result summary. */
export type SubagentDetail = z.infer<ReturnType<typeof SubagentDetailSchema>>;

/** Read the roster of one owning parent. */
export const SubagentRosterRequestSchema = lazySchema(() => z.object({
  owningParentThreadId: z.string().min(1),
}).strict());
/** Read the roster of one owning parent. */
export type SubagentRosterRequest = z.infer<ReturnType<typeof SubagentRosterRequestSchema>>;
/** Read a steps entry owned by the given parent. */
export const SubagentDetailRequestSchema = lazySchema(() => SubagentRosterRequestSchema().extend({ entryId: z.string().min(1) }));
/** Read a steps entry owned by the given parent. */
export type SubagentDetailRequest = z.infer<ReturnType<typeof SubagentDetailRequestSchema>>;
