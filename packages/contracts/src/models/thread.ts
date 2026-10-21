import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";
import { ScheduledTurnResumeSchema } from "./turn-recovery.js";
import { DevinModeSchema, ThreadStatusSchema, ThreadModeSchema, InteractionModeSchema, OrchestrationModeSchema, PermissionModeSchema } from "./enums.js";
import { ContextWindowModeSchema, ReasoningLevelSchema } from "./settings.js";

/** Durable progress of the thread's current planning conversation. */
export const PlanPhaseSchema = z.enum(["questions", "planning", "ready", "no_plan"]);
/** Planning state shared by thread hydration and attention. */
export type PlanPhase = z.infer<typeof PlanPhaseSchema>;

/** Whether a worktree thread is on a named branch or still branchless on HEAD. */
export const ThreadCheckoutStateSchema = z.enum(["named", "branchless"]);
/** Thread checkout state discriminator. */
export type ThreadCheckoutState = z.infer<typeof ThreadCheckoutStateSchema>;

/** Persisted state for automatic cleanup of an expired completed thread. */
export const ThreadCleanupStateSchema = z.enum(["queued", "running", "retrying", "blocked"]);
/** Automatic cleanup state for a completed thread. */
export type ThreadCleanupState = z.infer<typeof ThreadCleanupStateSchema>;

/** Thread schema matching the SQLite row shape. */
export const ThreadSchema = lazySchema(() =>
  z.object({
  id: z.string(),
  workspace_id: z.string(),
  title: z.string(),
  status: ThreadStatusSchema,
  mode: ThreadModeSchema,
  worktree_path: z.string().nullable(),
  branch: z.string(),
  checkout_state: ThreadCheckoutStateSchema.default("named"),
  base_branch: z.string().nullable().default(null),
  /** Short commit hash of a detached checkout's HEAD. Null on a named branch or before the first HEAD read. */
  head_sha: z.string().nullable().default(null),
  /** Whether the worktree was provisioned by the app (true) or attached externally (false). */
  worktree_managed: z.boolean(),
  issue_number: z.number().nullable(),
  pr_number: z.number().nullable(),
  pr_status: z.string().nullable(),
  /** Whether this thread has at least one turn snapshot with file changes. Used to skip listSnapshots on switch when false. */
  has_file_changes: z.boolean().default(false),
  /** The SDK's internal session ID, used for resumeSession after app restart. */
  sdk_session_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  model: z.string().nullable(),
  /** The AI provider used by this thread (e.g. "claude", "codex"). */
  provider: z.string().default("claude"),
  /** Every provider the thread has run on, in first-used order. Null until the thread first switches provider. */
  providers_used: z.array(z.string().max(64)).max(16).nullable().optional(),
  deleted_at: z.string().nullable(),
  /** Server timestamp for explicit user completion. Independent from runtime status. */
  user_completed_at: z.string().nullable(),
  /** Server timestamp after which automatic deletion can begin. */
  scheduled_deletion_at: z.string().nullable(),
  /** Explicit resume restored from the persisted thread schedule. */
  scheduled_resume: ScheduledTurnResumeSchema().nullable(),
  /** Current automatic cleanup state, or null before cleanup becomes due. */
  cleanup_state: ThreadCleanupStateSchema.nullable(),
  /** Bounded user-safe reason when automatic cleanup needs attention. */
  cleanup_reason: z.string().max(240).nullable(),
  /** Last known input token count from the most recent turn. */
  last_context_tokens: z.number().int().nonnegative().nullable(),
  /** Model's context window size from the most recent turn. */
  context_window: z.number().int().nonnegative().nullable(),
  /** Reasoning effort level last used in this thread. */
  reasoning_level: ReasoningLevelSchema.nullable(),
  /** Interaction mode last used (chat or plan). */
  interaction_mode: InteractionModeSchema.nullable(),
  plan_phase: PlanPhaseSchema.nullable(),
  /** Provider-agnostic proactive orchestration mode last used in this thread. */
  orchestration_mode: OrchestrationModeSchema.nullable(),
  /** Permission mode last used (full or supervised). */
  permission_mode: PermissionModeSchema.nullable(),
  /** Context window mode last used in this thread ("200k" or "1m"). */
  context_window_mode: ContextWindowModeSchema.nullable(),
  /** Boolean thinking toggle last used in this thread. Honored only by models with a thinking toggle (Haiku 4.5). */
  thinking: z.boolean().nullable(),
  /**
   * Codex: when true, request OpenAI fast service tier for turns; false = standard;
   * null = inherit global `settings.provider.codex.fastMode`.
   */
  codex_fast_mode: z.boolean().nullable(),
  /** Selected Copilot sub-agent name. Null means provider default (interactive). */
  /**
   * Devin native session mode restored when a thread returns to build from
   * plan. Null means the Devin CLI default (normal).
   */
  devin_mode: DevinModeSchema.nullable(),
  /**
   * Thread-scoped default open-in app id (registry id, e.g. "code"). Tier 1 of
   * the three-tier resolution in ADR-0005. Null means no override, so the app
   * falls back to the global default then auto-resolution.
   */
  default_open_in_app: z.string().nullable(),
  /** ID of the parent thread this was branched from. Null for root threads. */
  parent_thread_id: z.string().nullable(),
  /**
   * ID of the Coordinator that delegated this thread. Non-null marks a Delegated
   * sub-agent, which appears in its Coordinator's sub-agent roster, never in thread lists.
   */
  delegation_coordinator_thread_id: z.string().nullable(),
  /** ID of the message in the parent thread that marks the fork point. */
  forked_from_message_id: z.string().nullable(),
  /** Most recent compaction summary from the AI provider. Used to seed branched thread replays. */
  last_compact_summary: z.string().nullable(),
  }),
);
/** Thread record from the database. */
export type Thread = z.infer<ReturnType<typeof ThreadSchema>>;

/** True when the thread is a Delegated sub-agent, reached through its Coordinator rather than thread lists. */
export function isDelegatedSubagent(thread: Pick<Thread, "delegation_coordinator_thread_id">): boolean {
  return thread.delegation_coordinator_thread_id !== null;
}

/**
 * Thread plus a small slice of its parent workspace, used by the cross-workspace
 * recent-threads landing list. The join is denormalized at the RPC boundary so
 * the renderer can show project context per row without enriching afterwards.
 */
export const RecentThreadSchema = lazySchema(() =>
  ThreadSchema().extend({
    workspace_name: z.string(),
    workspace_path: z.string(),
  }),
);
export type RecentThread = z.infer<ReturnType<typeof RecentThreadSchema>>;
