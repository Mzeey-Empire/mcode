import { z } from "zod";
import { MessageRoleSchema } from "./enums.js";
import { StoredAttachmentSchema } from "./attachment.js";
import { lazySchema } from "../utils/lazySchema.js";
import { MessageMentionsSchema } from "./mention.js";
import { SelectedTextCommentsSchema } from "./selected-text-comment.js";
import { PreviewAnnotationBundleSchema } from "./browser-preview.js";
import { ProviderIdentitySchema } from "../compat/agent-model.js";
import { TurnOutcomeSchema } from "./turn-outcome.js";

/** Canonical provenance for a user-side message sent by a parent agent. */
export const ParentAgentMessageProvenanceSchema = lazySchema(() => z.object({
  parentThreadId: z.string().trim().min(1).max(256),
  parentTurnId: z.string().trim().min(1).max(256),
  parentItemId: z.string().trim().min(1).max(256),
  providerIdentities: z.array(ProviderIdentitySchema).max(16),
}).strict());

/** Canonical provenance for a user-side message sent by a parent agent. */
export type ParentAgentMessageProvenance = z.infer<ReturnType<typeof ParentAgentMessageProvenanceSchema>>;

/** Provenance for a retained message that originated in the legacy conversation store. */
export const LegacyMessageProvenanceSchema = lazySchema(() => z.object({
  source: z.literal("messages"),
  migrationVersion: z.number().int().positive().nullable(),
  mapping: z.enum(["canonical", "legacy"]),
  reason: z.string().optional(),
}));

/** Provenance for a retained message that originated in the legacy conversation store. */
export type LegacyMessageProvenance = z.infer<ReturnType<typeof LegacyMessageProvenanceSchema>>;

/** What a Coordinator wake-up reports about one delegated task. */
export const DelegatedTaskNoticeStatusSchema = z.enum(["completed", "failed", "cancelled", "interrupted", "denied", "needs_input", "setup_blocked"]);
/** What a Coordinator wake-up reports about one delegated task. */
export type DelegatedTaskNoticeStatus = z.infer<typeof DelegatedTaskNoticeStatusSchema>;

/** One delegated task announced by a Coordinator wake-up message. */
export interface DelegatedTaskNotice {
  taskId: string;
  /** Null when the task never got a Delegated thread, such as a denied delegation. */
  threadId: string | null;
  title: string;
  providerId: string;
  status: DelegatedTaskNoticeStatus;
}

/** Typed metadata retained with a provider system notice. */
export interface SystemNoticeMetadata {
  /**
   * `provider-turn` marks the opening line of a turn the provider started without a prompt.
   * `delegated-task` marks a user-role message that the server wrote to wake a Coordinator, so it renders as from the Delegated thread.
   */
  kind: "diagnostic" | "warning" | "security" | "configuration" | "deprecation" | "model-rerouted" | "authentication-recovered" | "provider-turn" | "turn-reverted" | "turn-revert-undone" | "turn-revert-interrupted" | "delegated-task";
  revertId?: string;
  /** Set on an undo receipt: the revert it undid, so a reloaded timeline knows that revert can no longer be undone. */
  undoesRevertId?: string;
  /** Set on a revert receipt once an undo commits, so Undo stays hidden when the undo receipt is outside the loaded history. */
  undoneByRevertId?: string;
  presentation: "timeline" | "toast";
  scope?: "turn" | "session";
  sessionId?: string;
  noticeKey?: string;
  origin?: "unattributed-thread";
  fromModel?: string;
  toModel?: string;
  reason?: "safety" | "availability";
  configPath?: string;
  configRange?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  /** Set with kind `delegated-task`: the tasks this wake-up reports, in delivery order. */
  delegatedTasks?: DelegatedTaskNotice[];
}

/** Bounded provider-neutral metadata for a persisted system notice. */
export const SystemNoticeMetadataSchema = lazySchema<z.ZodType<SystemNoticeMetadata>>(() => z.object({
  kind: z.enum(["diagnostic", "warning", "security", "configuration", "deprecation", "model-rerouted", "authentication-recovered", "provider-turn", "turn-reverted", "turn-revert-undone", "turn-revert-interrupted", "delegated-task"]),
  revertId: z.string().max(64).optional(),
  undoesRevertId: z.string().max(64).optional(),
  undoneByRevertId: z.string().max(64).optional(),
  presentation: z.enum(["timeline", "toast"]),
  scope: z.enum(["turn", "session"]).optional(),
  sessionId: z.string().max(64).optional(),
  noticeKey: z.string().max(64).optional(),
  origin: z.literal("unattributed-thread").optional(),
  fromModel: z.string().max(128).optional(),
  toModel: z.string().max(128).optional(),
  reason: z.enum(["safety", "availability"]).optional(),
  configPath: z.string().max(1_024).optional(),
  configRange: z.object({
    startLine: z.number().int().nonnegative().max(1_000_000),
    startColumn: z.number().int().nonnegative().max(1_000_000),
    endLine: z.number().int().nonnegative().max(1_000_000),
    endColumn: z.number().int().nonnegative().max(1_000_000),
  }).optional(),
  delegatedTasks: z.array(z.object({
    taskId: z.string().min(1).max(256),
    threadId: z.string().min(1).max(256).nullable(),
    title: z.string().max(512),
    providerId: z.string().min(1).max(64),
    status: DelegatedTaskNoticeStatusSchema,
  }).strict()).min(1).max(32).optional(),
}).strict());

/** A handoff audit's directory name: a 26-character Crockford Base32 ULID. */
export const HandoffIdSchema = lazySchema(() => z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/));

/**
 * The provider switch a system message records. It lives beside `systemNotice` rather than as a notice kind
 * because builds that share the database parse `systemNotice` strictly and would reject a new kind.
 */
export const ProviderSwitchMarkerSchema = lazySchema(() => z.object({
  fromProvider: z.string().min(1).max(64),
  toProvider: z.string().min(1).max(64),
  /** Directory id of the stored audit of the history the new provider received. */
  handoffId: HandoffIdSchema(),
}).strict());

/** The provider switch a system message records. */
export type ProviderSwitchMarker = z.infer<ReturnType<typeof ProviderSwitchMarkerSchema>>;

/** Message schema matching the SQLite row shape. */
export const MessageSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    thread_id: z.string(),
    role: MessageRoleSchema,
    content: z.string(),
    tool_calls: z.unknown().nullable(),
    files_changed: z.unknown().nullable(),
    cost_usd: z.number().nullable(),
    tokens_used: z.number().nullable(),
    timestamp: z.string(),
    sequence: z.number(),
    attachments: z.array(StoredAttachmentSchema()).nullable(),
    previewAnnotations: PreviewAnnotationBundleSchema().nullable().optional(),
    mentions: MessageMentionsSchema().nullable().optional(),
    selectedTextComments: SelectedTextCommentsSchema().nullable().optional(),
    tool_call_count: z.number().optional(),
    reply_to_message_id: z.string().nullable().optional(),
    quoted_text: z.string().nullable().optional(),
    /**
     * Model identifier active when an assistant message was produced
     * (e.g. "claude-opus-4-7", "cursor-agent", "gpt-4.1"). Null for user
     * messages and for assistant messages persisted before the `model`
     * column existed.
     */
    model: z.string().nullable().optional(),
    /** Provider that produced an assistant message. Absent for user messages and rows that predate provider provenance. */
    provider: z.string().nullable().optional(),
    /** Terminal outcome written only when the turn finalizer proves its end. */
    outcome: TurnOutcomeSchema.nullable().optional(),
    /** Exact execution identity needed by existing retry recovery after reload. */
    outcomeExecutionId: z.string().nullable().optional(),
    /** Bounded provider notice metadata retained across transcript reloads. */
    systemNotice: SystemNoticeMetadataSchema().nullable().optional(),
    /** Set on the system message that marks a provider switch in the timeline. */
    providerSwitch: ProviderSwitchMarkerSchema().nullable().optional(),
    /**
     * When true, mcode hides this message from the chat timeline.
     * Used for hidden handoff turns on Cursor parent threads.
     * Omitted or false for all legacy rows that predate this column.
     */
    is_internal: z.boolean().optional(),
    legacyProvenance: LegacyMessageProvenanceSchema().optional(),
    parentAgentProvenance: ParentAgentMessageProvenanceSchema().optional(),
  }),
);
/** Message record from the database. */
export type Message = z.infer<ReturnType<typeof MessageSchema>>;

/** Push payload for a committed provider switch, with the timeline marker it wrote. */
export type ThreadProviderSwitchedEvent = {
  threadId: string;
  provider: string;
  model: string;
  /** Every provider the thread has run on, least recently used first, so the current provider is last. */
  providersUsed: string[];
  marker: Message;
};
const threadProviderSwitched = lazySchema(() => z.object({
  threadId: z.string(),
  provider: z.string(),
  model: z.string(),
  providersUsed: z.array(z.string()).max(16),
  marker: MessageSchema(),
}));
/** Push payload for a committed provider switch. The explicit type keeps the WebSocket channel declaration small. */
export const ThreadProviderSwitchedEventSchema: () => z.ZodType<ThreadProviderSwitchedEvent> = threadProviderSwitched;

/** Bounded current-provider-session notices, separate from transcript pagination. */
export const SessionNoticesSchema = lazySchema<z.ZodType<Message[]>>(() => z.array(MessageSchema()).max(20));

/** Paginated message list with cursor metadata. */
export const PaginatedMessagesSchema = lazySchema(() =>
  z.object({
    messages: z.array(MessageSchema()),
    hasMore: z.boolean(),
    /**
     * IDs of assistant messages whose plan-questions block has been answered.
     * Used by the web client to suppress the plan-question wizard from
     * re-popping after restarts or mid-turn errors. Optional for backwards
     * compatibility — older servers omit it and the client falls back to the
     * structural heuristic.
     */
    answeredPlanMessageIds: z.array(z.string()).optional(),
  }),
);
/** Paginated message response from the server. */
export type PaginatedMessages = z.infer<ReturnType<typeof PaginatedMessagesSchema>>;
