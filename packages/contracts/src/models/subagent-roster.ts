import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderIdSchema } from "./settings.js";

/**
 * One normalized subagent state shared by every surface, in thread-row words.
 * `needs-you` is a live child blocked on the user's answer; `setting-up` is a
 * child that is launching or still in startup.
 */
export const SubagentStatusSchema = z.enum(["needs-you", "setting-up", "running", "failed", "stopped", "finished"]);
/** One normalized subagent state shared by every surface. */
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/** Whether a child is still live: setting up, working, or blocked on the user's answer. */
export function isLiveSubagentStatus(status: SubagentStatus): boolean {
  return status === "needs-you" || status === "setting-up" || status === "running";
}

const STATUS_RANK: Record<SubagentStatus, number> = {
  "needs-you": 0, "setting-up": 1, running: 2, failed: 3, stopped: 4, finished: 5,
};

/** Roster order shared by server and web: status rank, then newest start, then id. */
export function compareRosterEntries(
  a: Pick<SubagentRosterEntry, "status" | "startedAt" | "id">,
  b: Pick<SubagentRosterEntry, "status" | "startedAt" | "id">,
): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id);
}
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
  reasoningEffort: z.string().nullable(),
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

/** One parent roster, ordered by `compareRosterEntries`: needs-you, setting-up, running, failed, stopped, finished; newest first within each, then by id. */
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

const NATIVE_SUBAGENT_TOOL_NAME = "Agent";
// Codex names MCP calls `mcp:<server>/<tool>` and Claude `mcp__<server>__<tool>`.
const MCODE_MCP_PREFIX = /^(?:mcp__mcode__|mcp:mcode\/)/;

/** Strips the Mcode MCP server prefix from a tool name, under any provider's MCP naming. */
export function stripMcodeMcpPrefix(toolName: string): string {
  return toolName.replace(MCODE_MCP_PREFIX, "");
}

/** True when a tool call is the Mcode `delegate_task` tool, under any provider's MCP naming. */
export function isDelegateTaskToolName(toolName: string): boolean {
  return stripMcodeMcpPrefix(toolName) === "delegate_task";
}

/** Roster entry id of an Mcode delegated task, shared by the server roster and client links. */
export function delegatedTaskRosterEntryId(taskId: string): string {
  return `task:${taskId}`;
}

/** True when a tool call starts a sub-agent: a provider-native `Agent` call or an Mcode delegation. */
export function isSubagentLaunchToolName(toolName: string): boolean {
  return toolName === NATIVE_SUBAGENT_TOOL_NAME || isDelegateTaskToolName(toolName);
}

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
