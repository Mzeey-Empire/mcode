import { z } from "zod";
import { WorkspaceSchema, WorkspaceEnrichmentSchema } from "../models/workspace.js";
import { ThreadSchema } from "../models/thread.js";
import { ThreadModeSchema, PermissionModeSchema, InteractionModeSchema } from "../models/enums.js";
import { PaginatedMessagesSchema } from "../models/message.js";
import { AttachmentMetaSchema } from "../models/attachment.js";
import { ToolCallRecordSchema } from "../models/tool-call-record.js";
import { GitBranchSchema, WorktreeSchema } from "../git.js";
import { GitCommitSchema } from "../models/git-commit.js";
import { PrInfoSchema, PrDetailSchema, PrDraftSchema, CreatePrResultSchema, ChecksStatusSchema } from "../github.js";
import { SkillInfoSchema, SkillDiagnosticsSchema } from "../skills.js";
import { TurnSnapshotSchema } from "../models/turn-snapshot.js";
import { PlanAnswerSchema } from "../models/plan-questions.js";
import { DiffStatsSchema } from "../models/diff-stats.js";
import {
  SettingsSchema,
  PartialSettingsSchema,
  ReasoningLevelSchema,
  ProviderIdSchema,
  ContextWindowModeSchema,
} from "../models/settings.js";
import { lazySchema } from "../utils/lazySchema.js";
import { ProviderModelInfoSchema } from "../providers/models.js";
import { ProviderUsageInfoSchema } from "../providers/usage.js";
import { ProviderAvailabilitySchema } from "../providers/availability.js";
import { CopilotSubagentSchema, CopilotAgentNameSchema } from "../providers/copilot-agent.js";
import { PermissionDecisionSchema, PermissionRequestSchema } from "../models/permission.js";

/** Schema for creating a new thread. */
export const CreateThreadSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    title: z.string(),
    mode: ThreadModeSchema,
    branch: z.string(),
  }),
);

/** Schema for sending a message to an existing thread. */
export const SendMessageSchema = lazySchema(() =>
  z.object({
    threadId: z.string(),
    content: z.string(),
    model: z.string().optional(),
    permissionMode: PermissionModeSchema.optional(),
    attachments: z.array(AttachmentMetaSchema).optional(),
    reasoningLevel: ReasoningLevelSchema.optional(),
    provider: ProviderIdSchema.optional(),
    /** When "plan", the server wraps the message with the plan-mode question prompt. */
    interactionMode: InteractionModeSchema.optional(),
    /** USD budget cap for this session. 0 or absent disables. */
    maxBudgetUsd: z.number().nonnegative().finite().optional(),
    /** Maximum agent turns. 0 or absent disables. */
    maxTurns: z.number().int().nonnegative().optional(),
    /** Copilot sub-agent to activate for this message. Ignored by other providers. */
    copilotAgent: CopilotAgentNameSchema.optional(),
    /** Context window tier ("200k" default, "1m" extended). Honored only by 1M-capable Claude models. */
    contextWindow: ContextWindowModeSchema.optional(),
    /** Boolean thinking toggle. Honored only by models with a thinking toggle (Haiku 4.5). */
    thinking: z.boolean().optional(),
  }),
);

/** Schema for creating a thread and sending a message in one call. */
export const CreateAndSendSchema = lazySchema(() =>
  z.object({
    workspaceId: z.string(),
    content: z.string(),
    model: z.string(),
    permissionMode: PermissionModeSchema.optional(),
    mode: ThreadModeSchema.optional(),
    branch: z.string().optional(),
    existingWorktreePath: z.string().optional(),
    attachments: z.array(AttachmentMetaSchema).optional(),
    reasoningLevel: ReasoningLevelSchema.optional(),
    provider: ProviderIdSchema.optional(),
    /** When "plan", the server wraps the message with the plan-mode question prompt. */
    interactionMode: InteractionModeSchema.optional(),
    /** USD budget cap for this session. 0 or absent disables. */
    maxBudgetUsd: z.number().nonnegative().finite().optional(),
    /** Maximum agent turns. 0 or absent disables. */
    maxTurns: z.number().int().nonnegative().optional(),
    /** Copilot sub-agent to activate for this thread. Ignored by other providers. */
    copilotAgent: CopilotAgentNameSchema.optional(),
    /** Context window tier ("200k" default, "1m" extended). Honored only by 1M-capable Claude models. */
    contextWindow: ContextWindowModeSchema.optional(),
    /** Boolean thinking toggle. Honored only by models with a thinking toggle (Haiku 4.5). */
    thinking: z.boolean().optional(),
    /** Source thread ID when branching from an existing thread. */
  parentThreadId: z.string().optional(),
  /** Fork-point message ID in the parent thread. Defaults to last persisted message. */
  forkedFromMessageId: z.string().optional(),
}).refine(
  (d) => !d.forkedFromMessageId || d.parentThreadId,
  { message: "forkedFromMessageId requires parentThreadId", path: ["forkedFromMessageId"] },
  ),
);

/** All RPC method definitions keyed by method name with params and result schemas. */
export const WS_METHODS = lazySchema(() => ({
  "workspace.list": {
    params: z.object({}),
    result: z.array(WorkspaceSchema()),
  },
  "workspace.create": {
    params: z.object({ name: z.string(), path: z.string() }),
    result: WorkspaceSchema(),
  },
  "workspace.delete": {
    params: z.object({ id: z.string() }),
    result: z.boolean(),
  },
  /** Pin or unpin a workspace in the project selector. */
  "workspace.pin": {
    params: z.object({ id: z.string(), pinned: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Remove a workspace from the recent/pinned list without deleting it. */
  "workspace.removeRecent": {
    params: z.object({ id: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Record that a workspace was just opened, updating its recency timestamp. */
  "workspace.touchLastOpened": {
    params: z.object({ id: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** Batch-fetch git + thread enrichment for up to 200 workspace ids. */
  "workspace.enrich": {
    params: z.object({ ids: z.array(z.string()).max(200) }),
    result: z.object({ items: z.array(WorkspaceEnrichmentSchema()) }),
  },
  /** Browse the host filesystem starting at the given path, for the folder picker. */
  "filesystem.browse": {
    params: z.object({ path: z.string() }),
    result: z.object({
      path: z.string(),
      parent: z.string().nullable(),
      entries: z.array(z.object({ name: z.string(), isDir: z.boolean() })),
    }),
  },
  "thread.list": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(ThreadSchema()),
  },
  "thread.create": {
    params: CreateThreadSchema(),
    result: ThreadSchema(),
  },
  "thread.delete": {
    params: z.object({
      threadId: z.string(),
      cleanupWorktree: z.boolean(),
    }),
    result: z.boolean(),
  },
  "thread.updateTitle": {
    params: z.object({ threadId: z.string(), title: z.string() }),
    result: z.boolean(),
  },
  "thread.updateSettings": {
    params: z.object({
      threadId: z.string(),
      reasoningLevel: ReasoningLevelSchema.optional(),
      interactionMode: InteractionModeSchema.optional(),
      permissionMode: PermissionModeSchema.optional(),
      /** Copilot-specific: name of the selected sub-agent. Pass null to clear back to provider default. */
      copilotAgent: CopilotAgentNameSchema.nullable().optional(),
      /** Context window tier persisted on the thread. Pass null to clear back to the global default. */
      contextWindow: ContextWindowModeSchema.nullable().optional(),
      /** Boolean thinking toggle persisted on the thread. Honored only for Haiku-class models. Pass null to clear. */
      thinking: z.boolean().nullable().optional(),
    }).refine(
      (data) =>
        data.reasoningLevel !== undefined ||
        data.interactionMode !== undefined ||
        data.permissionMode !== undefined ||
        data.copilotAgent !== undefined ||
        data.contextWindow !== undefined ||
        data.thinking !== undefined,
      { message: "Must provide at least one setting to update" },
    ),
    result: z.boolean(),
  },
  "thread.markViewed": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  "thread.syncPrs": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(z.object({
      threadId: z.string(),
      /** null signals the PR was cleared from this thread (stale data removed). */
      prNumber: z.number().nullable(),
      prStatus: z.string().nullable(),
    })),
  },
  "git.listBranches": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(GitBranchSchema),
  },
  "git.currentBranch": {
    params: z.object({ workspaceId: z.string() }),
    result: z.string().nullable(),
  },
  "git.checkout": {
    params: z.object({ workspaceId: z.string(), branch: z.string() }),
    result: z.void(),
  },
  "git.listWorktrees": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(WorktreeSchema),
  },
  "git.fetchBranch": {
    params: z.object({
      workspaceId: z.string(),
      branch: z.string(),
      prNumber: z.number().optional(),
    }),
    result: z.void(),
  },
  "git.log": {
    params: z.object({
      workspaceId: z.string(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      threadId: z.string().optional(),
    }),
    result: z.array(GitCommitSchema),
  },
  "git.commitDiff": {
    params: z.object({
      workspaceId: z.string(),
      sha: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "git.commitFiles": {
    params: z.object({
      workspaceId: z.string(),
      sha: z.string(),
    }),
    result: z.array(z.string()),
  },
  "agent.send": {
    params: SendMessageSchema(),
    result: z.void(),
  },
  "agent.createAndSend": {
    params: CreateAndSendSchema(),
    result: ThreadSchema(),
  },
  "agent.stop": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  "agent.activeCount": {
    params: z.object({}),
    result: z.number(),
  },
  "agent.listRunning": {
    params: z.object({}),
    result: z.array(z.string()),
  },
  "agent.answerQuestions": {
    params: z.object({
      threadId: z.string(),
      answers: z.array(PlanAnswerSchema),
      permissionMode: PermissionModeSchema.optional(),
      reasoningLevel: ReasoningLevelSchema.optional(),
      contextWindow: ContextWindowModeSchema.optional(),
      thinking: z.boolean().optional(),
    }),
    result: z.void(),
  },
  "permission.respond": {
    params: z.object({
      requestId: z.string(),
      decision: PermissionDecisionSchema,
    }),
    result: z.void(),
  },
  /** Returns pending permission requests for a thread; used to re-hydrate the frontend after a WebSocket reconnect. */
  "permission.listPending": {
    params: z.object({ threadId: z.string() }),
    result: z.array(PermissionRequestSchema()),
  },
  "message.list": {
    params: z.object({
      threadId: z.string(),
      limit: z.number().int().min(1).max(1000),
      before: z.number().int().optional(),
    }),
    result: PaginatedMessagesSchema,
  },
  "file.list": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string().optional(),
    }),
    result: z.array(z.string()),
  },
  "file.read": {
    params: z.object({
      workspaceId: z.string(),
      relativePath: z.string(),
      threadId: z.string().optional(),
    }),
    result: z.string(),
  },
  "github.branchPr": {
    params: z.object({ branch: z.string(), cwd: z.string() }),
    result: PrInfoSchema().nullable(),
  },
  "github.listOpenPrs": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(PrDetailSchema()),
  },
  "github.prByUrl": {
    params: z.object({ url: z.string() }),
    result: PrDetailSchema().nullable(),
  },
  "git.push": {
    params: z.object({
      workspaceId: z.string(),
      branch: z.string(),
    }),
    result: z.object({ success: z.boolean() }),
  },
  "github.generatePrDraft": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string(),
      baseBranch: z.string(),
    }),
    result: PrDraftSchema(),
  },
  "github.createPr": {
    params: z.object({
      workspaceId: z.string(),
      threadId: z.string(),
      title: z.string().max(256),
      body: z.string().max(65536),
      baseBranch: z.string(),
      isDraft: z.boolean().default(false),
    }),
    result: CreatePrResultSchema(),
  },
  "github.checkStatus": {
    params: z.object({ threadId: z.string() }),
    result: ChecksStatusSchema(),
  },
  "config.discover": {
    params: z.object({ workspacePath: z.string() }),
    result: z.record(z.unknown()),
  },
  "skill.list": {
    params: z.object({
      cwd: z.string().optional(),
      providerId: z.string().optional(),
    }),
    result: z.array(SkillInfoSchema()),
  },
  "skill.diagnose": {
    params: z.object({ cwd: z.string().optional() }),
    result: SkillDiagnosticsSchema(),
  },
  "terminal.create": {
    params: z.object({ threadId: z.string() }),
    result: z.string(),
  },
  "terminal.write": {
    params: z.object({ ptyId: z.string(), data: z.string() }),
    result: z.void(),
  },
  "terminal.resize": {
    params: z.object({
      ptyId: z.string(),
      cols: z.number(),
      rows: z.number(),
    }),
    result: z.void(),
  },
  "terminal.kill": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.pause": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.resume": {
    params: z.object({ ptyId: z.string() }),
    result: z.void(),
  },
  "terminal.killByThread": {
    params: z.object({ threadId: z.string() }),
    result: z.void(),
  },
  /**
   * Reattach to a PTY after a WebSocket reconnect.
   * The server replays buffered chunks (as binary frames) with seq > lastSeq,
   * then returns a flag indicating whether the replay window was exceeded.
   */
  "terminal.reattach": {
    params: z.object({
      ptyId: z.string(),
      /**
       * Last sequence number the client received before the disconnect.
       * Pass -1 when the client has seen no output (replay everything).
       */
      lastSeq: z.number().int().min(-1),
    }),
    result: z.object({
      /** True when eviction means the client may have missed output. */
      gapped: z.boolean(),
    }),
  },
  /** List all active PTY sessions on the server. Used during reconnect. */
  "terminal.listActive": {
    params: z.object({}),
    result: z.array(
      z.object({ ptyId: z.string(), threadId: z.string() }),
    ),
  },
  /**
   * Check whether a PTY has non-shell child processes currently running.
   * Used by the optional kill confirmation feature.
   */
  "terminal.hasChildren": {
    params: z.object({ ptyId: z.string() }),
    result: z.object({ hasChildren: z.boolean() }),
  },
  "app.version": {
    params: z.object({}),
    result: z.string(),
  },
  "toolCallRecord.list": {
    params: z.object({ messageId: z.string() }),
    result: z.array(ToolCallRecordSchema),
  },
  "toolCallRecord.listByParent": {
    params: z.object({ parentToolCallId: z.string() }),
    result: z.array(ToolCallRecordSchema),
  },
  "thread.getTasks": {
    params: z.object({ threadId: z.string() }),
    // Note: `group` is intentionally absent from the wire format — the SDK's TodoWrite tool
    // does not provide grouping metadata, so clients assign all tasks to a single "Tasks" group.
    // If a future SDK version adds grouping, this schema and StoredTask will need to be extended.
    result: z
      .array(z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
      }))
      .nullable(),
  },
  "snapshot.getDiff": {
    params: z.object({
      snapshotId: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "snapshot.getDiffStats": {
    params: z.object({ snapshotId: z.string() }),
    result: z.array(DiffStatsSchema()),
  },
  "snapshot.cleanup": {
    params: z.object({}),
    result: z.object({ removed: z.number() }),
  },
  "snapshot.listByThread": {
    params: z.object({ threadId: z.string() }),
    result: z.array(TurnSnapshotSchema),
  },
  "snapshot.getCumulativeDiff": {
    params: z.object({
      threadId: z.string(),
      filePath: z.string().optional(),
      maxLines: z.number().int().positive().optional(),
    }),
    result: z.string(),
  },
  "clipboard.saveFile": {
    params: z.object({
      /**
       * Base64-encoded file content. Optional when using binary WebSocket upload
       * (the payload arrives as a separate binary frame).
       */
      data: z.string().min(1).max(45_000_000).optional(),
      /** MIME type of the file (e.g. "application/pdf", "text/plain"). */
      mimeType: z.string().min(1).max(127),
      /** Display name for the file (e.g. "document.pdf"). No path separators allowed. */
      fileName: z
        .string()
        .min(1)
        .max(255)
        .refine(
          (v) => !/[/\\\0]/.test(v),
          "fileName must not contain path separators or null bytes",
        ),
    }),
    result: AttachmentMetaSchema,
  },
  "settings.get": {
    params: z.object({}),
    result: SettingsSchema(),
  },
  "settings.update": {
    params: PartialSettingsSchema(),
    result: SettingsSchema(),
  },
  "provider.listModels": {
    params: z.object({ providerId: ProviderIdSchema }),
    result: z.array(ProviderModelInfoSchema()),
  },
  "provider.getUsage": {
    params: z.object({ providerId: ProviderIdSchema }),
    result: ProviderUsageInfoSchema(),
  },
  "memory.setBackground": {
    params: z.object({ background: z.boolean() }),
    result: z.void(),
  },
  "provider.copilotAgents": {
    params: z.object({
      workspaceId: z.string(),
    }),
    result: z.array(CopilotSubagentSchema()),
  },
  "providers.listAvailability": {
    params: z.object({}),
    result: z.array(ProviderAvailabilitySchema()),
  },
} as const));

/** Union of all RPC method names. */
export type WsMethodName = keyof ReturnType<typeof WS_METHODS>;
