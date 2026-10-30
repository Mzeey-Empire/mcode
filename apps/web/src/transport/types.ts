/** A rendered message keeps server sequence provenance separate from live ordering guesses. */
export type Message = import("@mcode/contracts/models/message").Message & { serverSequence?: number };

/** What `plan.snapshot` returns: every plan version of a thread and its comments. */
export interface PlanSnapshot {
  readonly versions: import("@mcode/contracts/models/plan").PlanVersion[];
  readonly comments: import("@mcode/contracts/models/plan").PlanComment[];
}

// Import shared types for local use in the McodeTransport interface.
import type { DiffStats } from "@mcode/contracts/models/diff-stats";
import type { HandoffAuditMetadata } from "@mcode/contracts/handoff";
import type { ProjectIcon } from "@mcode/contracts/models/project-icon";
import type { TurnSteerParams, TurnSteerResult, ListHeldSteersResult, SettleUnknownSteerParams, SettleUnknownSteerResult } from "@mcode/contracts/models/turn-steer";
import type { TurnRetryParams, TurnResumeScheduleParams, ScheduledTurnResume, TurnRetryResult, TurnResumeParams, TurnResumeResult } from "@mcode/contracts/models/turn-recovery";
import type { WorkspaceFileList, WorkspaceFileChanges, FileReadResult } from "@mcode/contracts/models/workspace-file";
import type { FilesystemBrowseResult, WorkspaceCreateResult, CreateAndSendResult, SetThreadSubscriptionsInput, SetThreadSubscriptionsResult, SendMessageInput, CreateAndSendInput, ThreadCompletionResult } from "@mcode/contracts/ws/methods";
import type { ReviewComparisonResult, ReviewFileDiffResult, ReviewTurn } from "@mcode/contracts/models/review-comparison";
import type { Workspace, WorkspaceEnrichment } from "@mcode/contracts/models/workspace";
import type { WorkspaceEnvironmentDocument, WorkspaceEnvironmentReadResult, WorkspaceEnvironmentStorageMode, WorkspaceEnvironmentCommandTarget, WorkspaceEnvironmentAutomaticSetupSnapshot, WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import type { Thread, RecentThread } from "@mcode/contracts/models/thread";
import type { PaginatedMessages } from "@mcode/contracts/models/message";
import type { AttachmentMeta } from "@mcode/contracts/models/attachment";
import type { GitRefsListParams, GitRefsListResult, BranchComparison, WorktreeInfo, GitRemoteUrl } from "@mcode/contracts/git";
import type { PullRequestTargetsListParams, PullRequestTargetsListResult, PrInfo, PrDraft, CreatePrResult, ChecksStatus } from "@mcode/contracts/github";
import type { ProviderCatalogRequest, ProviderCatalogSnapshot } from "@mcode/contracts/providers/capability-catalog";
import type { PermissionMode, InteractionMode, OrchestrationMode, DevinMode } from "@mcode/contracts/models/enums";
import type { ReasoningLevel, ContextWindowMode, Settings, PartialSettings } from "@mcode/contracts/models/settings";
import type { ToolCallRecord } from "@mcode/contracts/models/tool-call-record";
import type { ThoughtSegmentRecord } from "@mcode/contracts/models/thought-segment";
import type { HookExecutionRecord } from "@mcode/contracts/models/hook-execution";
import type { TurnSnapshot } from "@mcode/contracts/models/turn-snapshot";
import type { TurnRevertPreview, TurnRevertResult, TurnRevertScope } from "@mcode/contracts/models/turn-revert";
import type { GitCommit } from "@mcode/contracts/models/git-commit";
import type { PlanAnswer } from "@mcode/contracts/models/plan-questions";
import type { ProviderModelInfo } from "@mcode/contracts/providers/models";
import type { ProviderUsageInfo } from "@mcode/contracts/providers/usage";
import type { ProviderAvailability } from "@mcode/contracts/providers/availability";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import type { ProviderStatus } from "@mcode/contracts/providers/provider-status";
import type { ApprovalResponse, ApprovalRespondResult, ApprovalRequest } from "@mcode/contracts/models/approval";
import type { ThreadStartup, ThreadStartupResolveInput, ThreadStartupListResult } from "@mcode/contracts/thread-startup";
import type { ConversationPage } from "@mcode/contracts/models/conversation-page";
import type { ConversationNewerPage, ConversationNewerPageRequest } from "@mcode/contracts/models/conversation-newer-page";
import type { ConversationOlderPage, ConversationOlderPageRequest } from "@mcode/contracts/models/conversation-older-page";
import type { ConversationTail } from "@mcode/contracts/models/conversation-tail";
import type { SubagentRoster, SubagentDetail } from "@mcode/contracts/models/subagent-roster";
import type { CanonicalSubagentStopResult } from "@mcode/contracts/models/canonical-subagent-roster";
import type { GoalLookupResult } from "@mcode/contracts/models/goal";
import type { BrowserAutomationHostRegistration, BrowserAutomationHostDispatchTarget, BrowserAutomationResponse } from "@mcode/contracts/models/browser-automation";
import type { PullRequestCapabilitiesRequest, PullRequestCapabilitiesResult, PullRequestListRequest, PullRequestListResult, PullRequestGetRequest, PullRequestGetResult, PullRequestTimelineRequest, PullRequestTimelineResult, PullRequestFilesRequest, PullRequestFilesResult, PullRequestPatchRequest, PullRequestPatchResult, PullRequestCancelRequest, PullRequestCancelResult, PullRequestCreateReviewTaskRequest, PullRequestCreateReviewTaskResult, PullRequestReviewLinkRequest, PullRequestReviewLinkResult, PullRequestPostCommentRequest, PullRequestPostCommentResult, PullRequestSubmitReviewRequest, PullRequestSubmitReviewResult, PullRequestSetReadinessRequest, PullRequestSetReadinessResult, PullRequestCloseRequest, PullRequestCloseResult, PullRequestMergeRequest, PullRequestMergeResult } from "@mcode/contracts/pull-requests";
import type { AgentStopResult } from "@mcode/contracts/models/turn-runtime";
import type { TerminalBackendCapabilities } from "@mcode/contracts/models/terminal-backend";
import type { TerminalCustomProfile, TerminalProfileReference, TerminalResolvedProfile } from "@mcode/contracts/models/terminal";
import type { TerminalPreferencesUpdate, TerminalProfileRecovery } from "@mcode/contracts/models/terminal-settings";

// Re-export shared types from the contracts package (single source of truth).
export type { GitRefsListResult, GitBranch, BranchComparison, GitRemoteUrl, WorktreeInfo } from "@mcode/contracts/git";
export type { PullRequestTargetsListResult, PrInfo } from "@mcode/contracts/github";
export type { Workspace, WorkspaceEnrichment } from "@mcode/contracts/models/workspace";
export type { WorkspaceEnvironmentDocument, WorkspaceEnvironmentReadResult, WorkspaceEnvironmentAutomaticSetupSnapshot, WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
export type { Thread, RecentThread } from "@mcode/contracts/models/thread";
export type { AttachmentMeta, StoredAttachment } from "@mcode/contracts/models/attachment";
export type { ProviderCatalogRequest, ProviderCatalogSnapshot } from "@mcode/contracts/providers/capability-catalog";
export type { PermissionMode, InteractionMode } from "@mcode/contracts/models/enums";
export type { ContextWindowMode, Settings, PartialSettings } from "@mcode/contracts/models/settings";
export type { GitCommit } from "@mcode/contracts/models/git-commit";
export type { PlanAnswer } from "@mcode/contracts/models/plan-questions";
export type { ProviderModelInfo } from "@mcode/contracts/providers/models";
export type { MessageMention } from "@mcode/contracts/models/mention";
export type { PullRequestCapabilities, PullRequestCapabilityLimitation, PullRequestError, PullRequestIdentity, PullRequestRelationship, PullRequestState, PullRequestSummary, PullRequestBoundedDataMarker, PullRequestCheck, PullRequestConversationItem, PullRequestDetail, PullRequestGetResource, PullRequestTimelineItem, PullRequestTimelineKind, PullRequestTimelineLane, PullRequestFile, PullRequestFileChangeType, PullRequestFilePatchStatus, PullRequestPatchResult } from "@mcode/contracts/pull-requests";
export type { SendMessageInput, CreateAndSendInput } from "@mcode/contracts/ws/methods";
export type { TurnSteerParams, TurnSteerResult, ListHeldSteersResult, SettleUnknownSteerParams, SettleUnknownSteerResult } from "@mcode/contracts/models/turn-steer";

import type { BuildStage } from "@mcode/contracts/build-stage";
export type { PaginatedMessages } from "@mcode/contracts/models/message";
export type { ConversationPage } from "@mcode/contracts/models/conversation-page";
export type { ConversationTail } from "@mcode/contracts/models/conversation-tail";
export type { ToolCallRecord } from "@mcode/contracts/models/tool-call-record";
export type { ThoughtSegmentRecord } from "@mcode/contracts/models/thought-segment";
export type { HookExecutionRecord } from "@mcode/contracts/models/hook-execution";
export type { TurnSnapshot } from "@mcode/contracts/models/turn-snapshot";

/** Server response containing detected certified and persisted custom profiles. */
export interface TerminalProfileList {
  readonly certified: readonly TerminalResolvedProfile[];
  readonly custom: readonly TerminalCustomProfile[];
  readonly recovery?: TerminalProfileRecovery;
}

/** Explicit or inherited workspace Terminal default-profile state. */
export interface TerminalWorkspacePreference {
  readonly workspaceId: string;
  readonly defaultProfileId: TerminalProfileReference | null;
}

/** Result returned after a live Terminal preference update. */
export interface TerminalPreferencesResult {
  readonly terminal: {
    readonly presentation: import("@mcode/contracts/models/terminal-settings").TerminalSettings["presentation"];
    readonly behavior: import("@mcode/contracts/models/terminal-settings").TerminalSettings["behavior"];
    readonly accessibility: import("@mcode/contracts/models/terminal-settings").TerminalSettings["accessibility"];
  };
}

export { PERMISSION_MODES, INTERACTION_MODES } from "@mcode/contracts/models/enums";

/** In-progress tool call tracked by the frontend streaming layer. */
export interface ToolCall {
  /** Explicit provider-neutral execution state, including permission waits and refusals. */
  status?: "queued" | "waiting" | "running" | "completed" | "failed" | "cancelled" | "denied";
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Provider-neutral presentation consumed by sub-agent surfaces. */
  subagentPresentation?: import("@mcode/contracts/models/tool-call-record").SubagentPresentation;
  output: string | null;
  isError: boolean;
  isComplete: boolean;
  /** True when a persisted tool call ended through cancellation. */
  isCancelled?: boolean;
  /** True when the call keeps running after its turn ends; only its own late result completes it. */
  background?: boolean;
  /** True when the live output preview omits middle bytes from the full output. */
  outputTruncated?: boolean;
  /** UTF-8 byte count for the full output when the server bounded the preview. */
  outputTotalBytes?: number;
  /** Runtime artifact path containing the full output when truncation occurred. */
  outputArtifactPath?: string;
  /** ID of the parent Agent tool call, if this is a subagent child. */
  parentToolCallId?: string;
  /** Elapsed wall-clock seconds reported by the most recent toolProgress event. */
  elapsedSeconds?: number;
  /** Epoch ms when the toolUse event was received, used for duration display. */
  startedAt?: number;
  /** Epoch ms when the provider last reported meaningful activity for this call. */
  lastActivityAt?: number;
  /** Wall-clock duration when the tool call completed (ms). */
  durationMs?: number;
  /** Process exit code reported for a completed shell command. */
  exitCode?: number;
}

/** Ephemeral hook execution state tracked during a session. Not persisted to DB. */
export interface HookExecution {
  hookName: string;
  hookType: "permission" | "stop";
  toolName?: string;
  status: "running" | "completed";
  /** Last 20 lines of hook output, shown by default in the UI. */
  outputLines: string[];
  /** Full hook output buffer, available via "show all" toggle. */
  fullOutput: string[];
  /** Persisted hook metadata rendered when stdout is unavailable. */
  detailLines?: string[];
  exitCode?: number;
  durationMs?: number;
  didBlock?: boolean;
  /** Timestamp when the hook started, used to derive an elapsed timer. */
  startedAt: number;
}

/** Category of an openable app, mirroring the desktop registry's adapter kinds. */
export type OpenInAppKind = "editor" | "gitGui" | "terminal" | "fileManager";

/**
 * Openable-app metadata as exposed by the desktop main-process registry. Icons
 * cannot cross the IPC boundary, so the registry supplies an {@link OpenInApp.iconKey}
 * the renderer maps to a component.
 */
export interface OpenInApp {
  /** Stable identifier used to dispatch launches (e.g. "code", "explorer"). */
  readonly id: string;
  /** Human-readable name shown in the menu (e.g. "VS Code"). */
  readonly label: string;
  /** App category, driving launch semantics and menu grouping. */
  readonly kind: OpenInAppKind;
  /** Renderer-side key for the app's icon component. */
  readonly iconKey: string;
  /** Whether the app is installed / available on this system. */
  readonly detected: boolean;
}

/** Options shared by Review diff reads. */
export interface DiffReadOptions {
  /** Hide whitespace changes in Git diffs; the server returns agent patches unchanged. */
  readonly ignoreWhitespace?: boolean;
}

/** Transport interface consumed by the web app to communicate with the backend. */
export interface McodeTransport {
  /** Register this renderer connection as an authorized visible-browser host. */
  registerBrowserAutomationHost(
    registration: BrowserAutomationHostRegistration,
  ): Promise<{ generation: number; desktopInstanceId: string }>;
  /** Replace the exact desktop-main-derived targets owned by this connection. */
  updateBrowserAutomationHostTargets(
    hostId: string,
    generation: number,
    targets: readonly BrowserAutomationHostDispatchTarget[],
  ): Promise<void>;
  /** Return one validated browser operation result to the broker. */
  respondToBrowserAutomationRequest(
    hostId: string,
    generation: number,
    response: BrowserAutomationResponse,
    target?: BrowserAutomationHostDispatchTarget,
  ): Promise<void>;
  /** Renew the browser host lease. */
  heartbeatBrowserAutomationHost(
    hostId: string,
    generation: number,
    observedAt: number,
  ): Promise<void>;
  /** Interrupt one in-flight request from the visible Browser. */
  cancelBrowserAutomationRequest(
    hostId: string,
    generation: number,
    requestId: string,
    sequence: number,
    reason: "human-interrupted" | "user-stopped" | "host-shutdown",
  ): Promise<void>;

  // Workspace commands
  createWorkspace(name: string | undefined, path: string): Promise<WorkspaceCreateResult>;
  listWorkspaces(): Promise<Workspace[]>;
  /** Resolve the icon each workspace shows; unknown or deleted ids are omitted. */
  resolveProjectIcons(workspaceIds: string[]): Promise<ProjectIcon[]>;
  /** Store a chosen icon path, or null to return to automatic detection. */
  setProjectIcon(workspaceId: string, iconPath: string | null): Promise<ProjectIcon>;
  /** Image files under the project root that can be chosen as its icon, with the match count before `limit`. */
  listProjectIconCandidates(workspaceId: string, query: string, limit?: number): Promise<{ files: string[]; total: number }>;
  /** Rename a workspace without changing its filesystem path. */
  renameWorkspace(id: string, name: string): Promise<Workspace>;
  /** Read the selected workspace environment document and revision. */
  readWorkspaceEnvironment(workspaceId: string, threadId?: string): Promise<WorkspaceEnvironmentReadResult>;
  /** Save the selected workspace environment document against its source revision. */
  saveWorkspaceEnvironment(
    workspaceId: string,
    document: WorkspaceEnvironmentDocument,
    sourceRevision: string | null,
    threadId?: string,
  ): Promise<WorkspaceEnvironmentReadResult>;
  /** Select system or shared storage for one Project environment. */
  setWorkspaceEnvironmentStorageMode(
    workspaceId: string,
    storageMode: WorkspaceEnvironmentStorageMode,
    threadId?: string,
  ): Promise<WorkspaceEnvironmentReadResult>;
  /** Approve one exact shared command before it starts. */
  approveWorkspaceEnvironmentCommand(
    threadId: string,
    target: WorkspaceEnvironmentCommandTarget,
    fingerprint: string,
  ): Promise<void>;
  /** Forget the stored approval for one shared Project action. */
  forgetWorkspaceEnvironmentApproval(workspaceId: string, actionId: string): Promise<void>;
  /** Release queued Turns without rerunning automatic Setup. */
  continueAutomaticSetup(threadId: string): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot>;
  /** Start one new automatic Setup attempt from the current Project environment. */
  retryAutomaticSetup(threadId: string): Promise<WorkspaceEnvironmentAutomaticSetupSnapshot>;
  /** Lists retained Project Action results for the current Thread. */
  listWorkspaceActionRuns(threadId: string): Promise<WorkspaceEnvironmentActionRun[]>;
  /**
   * Starts one configured Project Action in its private terminal session.
   * With `expectedRunId`, the server refuses with `WORKSPACE_ENVIRONMENT_RUN_CLOSED` rather than
   * open a new terminal once the run's pending terminal is gone.
   */
  startWorkspaceAction(threadId: string, actionId: string, expectedRunId?: string): Promise<WorkspaceEnvironmentActionRun>;
  /** Stops one running Project Action after its terminal close barrier completes. */
  stopWorkspaceAction(threadId: string, actionId: string): Promise<WorkspaceEnvironmentActionRun | null>;
  /** Restarts one Project Action only after its prior terminal fully closes. */
  restartWorkspaceAction(threadId: string, actionId: string): Promise<WorkspaceEnvironmentActionRun>;
  /** Reads the retained result for one Project Action slot. */
  getWorkspaceActionRun(threadId: string, actionId: string): Promise<WorkspaceEnvironmentActionRun | null>;
  deleteWorkspace(id: string): Promise<boolean>;
  /** Record workspace as last-opened for recency ordering in the project selector. */
  touchLastOpened(id: string): Promise<void>;
  /** Pin or unpin a workspace in the project selector. */
  pinWorkspace(id: string, pinned: boolean): Promise<void>;
  /** Remove a workspace from the recents list and unpin it. */
  removeRecent(id: string): Promise<void>;
  /** Persist sidebar index for a workspace after drag-and-drop (zero-based). */
  reorderWorkspace(id: string, newIndex: number): Promise<void>;
  /** Batch-fetch git branch, cleanliness, and thread count for the given workspace ids. */
  enrichWorkspaces(ids: string[]): Promise<{ items: WorkspaceEnrichment[] }>;
  /** Browse the host filesystem at the given path. Returns entries and parent path. */
  filesystemBrowse(path: string): Promise<FilesystemBrowseResult>;

  // Thread commands
  createThread(
    workspaceId: string,
    title: string,
    mode: "direct" | "worktree",
    branch: string,
  ): Promise<Thread>;
  /** Read every visible thread across workspaces. */
  listAllThreads(): Promise<Thread[]>;
  /** List the most recently active threads across all workspaces, joined with workspace name + path. */
  listRecentThreads(limit?: number): Promise<RecentThread[]>;
  /** Search threads across all workspaces by display and checkout metadata. */
  searchThreads(opts: {
    query: string;
    filters?: { status?: string[]; provider?: string[] };
    sort?: { field: "updated_at" | "created_at" | "title"; direction: "asc" | "desc" };
    limit?: number;
  }): Promise<{ threads: Thread[]; workspaces: { id: string; name: string; path: string }[] }>;
  deleteThread(threadId: string, cleanupWorktree: boolean): Promise<boolean>;
  /** Persist explicit user completion after server-side lifecycle guards pass. */
  completeThread(threadId: string, holdMs?: number): Promise<ThreadCompletionResult>;
  /** Reopen a completed thread and cancel its pending automatic deletion. */
  reopenThread(threadId: string): Promise<Thread>;
  /** Count completed threads that are blocked by the unsafe-worktree policy. */
  countBlockedThreadCleanupCandidates(): Promise<{ count: number }>;
  /** Retry cleanup for one blocked completed thread. */
  retryThreadCleanup(threadId: string): Promise<Thread>;

  // Git branch commands
  /** List qualified branch and worktree targets for one picker page. */
  listRefs(params: GitRefsListParams): Promise<GitRefsListResult>;
  /** List repository pull request targets with a GitHub total. */
  listPullRequestTargets(params: PullRequestTargetsListParams): Promise<PullRequestTargetsListResult>;
  getCurrentBranch(workspaceId: string): Promise<string | null>;
  checkoutBranch(workspaceId: string, branch: string): Promise<void>;
  createBranch(workspaceId: string, name: string, threadId?: string): Promise<{ branch: string }>;
  listWorktrees(workspaceId: string): Promise<WorktreeInfo[]>;

  // Agent commands
  sendMessage(input: SendMessageInput): Promise<void>;
  /** Add a message to the running turn. A replay with the same messageId never resends. */
  steerTurn(params: TurnSteerParams): Promise<TurnSteerResult>;
  /** Every steer the server holds because its delivery is unknown or its resend is queued. */
  listHeldSteers(): Promise<ListHeldSteersResult>;
  /** Send again or remove one held steer. */
  settleUnknownSteer(params: SettleUnknownSteerParams): Promise<SettleUnknownSteerResult>;
  /** Retry the thread's latest errored turn as a new attempt in the same provider session. */
  retryErroredTurn(params: TurnRetryParams): Promise<TurnRetryResult>;
  /** Resume the thread's latest usage-limited turn at a future time; replaces any earlier schedule. */
  scheduleTurnResume(params: TurnResumeScheduleParams): Promise<ScheduledTurnResume>;
  /** Cancel the thread's scheduled resume; succeeds when none exists. */
  unscheduleTurnResume(threadId: string): Promise<void>;
  /** Resume the thread's latest interrupted turn, continuing its provider session when the provider can. */
  resumeInterruptedTurn(params: TurnResumeParams): Promise<TurnResumeResult>;
  /** Read one authoritative startup lifecycle by its client-generated identity. */
  getThreadStartup(startupId: string): Promise<ThreadStartup | null>;
  /** List retained startup lifecycles for one workspace during recovery. */
  listThreadStartups(workspaceId: string): Promise<ThreadStartupListResult>;
  /** Request cancellation for one startup lifecycle. */
  cancelThreadStartup(startupId: string): Promise<ThreadStartup>;
  /** Releases a startup blocked on its origin fetch: fetch again, or start from the local branch. */
  resolveThreadStartup(startupId: string, action: ThreadStartupResolveInput["action"]): Promise<ThreadStartup>;
  /** Sends a startup's saved first message again after its agent failed before taking it; setup does not rerun. */
  retryThreadStartupAgent(startupId: string): Promise<ThreadStartup>;
  createAndSendMessage(input: CreateAndSendInput): Promise<CreateAndSendResult>;
  stopAgent(threadId: string): Promise<AgentStopResult>;
  /** Retry retained saving work without starting another provider execution. */
  retrySave(threadId: string): Promise<{ retried: boolean }>;
  /** Continue an active turn after the user accepts that its remaining text will not be saved. */
  /** Respond to a tool permission request from the agent. */
  respondToApproval(
    requestId: string,
    response: Exclude<ApprovalResponse, { autoDeny: string }>,
  ): Promise<ApprovalRespondResult>;
  /** List pending permission requests for a thread (used to re-hydrate after reconnect). */
  listPendingApprovals(threadId?: string): Promise<ApprovalRequest[]>;
  /** Submit answers to a plan-mode question batch and resume the agent session. */
  answerPlanQuestions(
    threadId: string,
    answers: PlanAnswer[],
    permissionMode?: PermissionMode,
    reasoningLevel?: ReasoningLevel,
    contextWindow?: ContextWindowMode,
    thinking?: boolean,
  ): Promise<void>;
  /**
   * Durably dismiss the latest plan-questions batch for a thread.
   * The server marks the batch as settled and broadcasts plan.answered;
   * the wizard does NOT re-appear on subsequent reloads.
   */
  dismissPlanQuestions(threadId: string): Promise<void>;
  readClipboardImage(): Promise<AttachmentMeta | null>;
  /** Save a clipboard file blob to disk via the server. Returns attachment metadata. */
  saveClipboardFile(data: ArrayBuffer, mimeType: string, fileName: string): Promise<AttachmentMeta | null>;
  /** Copies a saved image into the thread's durable draft storage and returns its staging reference. */
  stageDraftImage(threadId: string, attachment: AttachmentMeta): Promise<import("@mcode/contracts/models/next-message-draft").StagedDraftImage>;
  getActiveAgentCount(): Promise<number>;
  /**
   * Returns runtime snapshots for live sessions, used to reconcile optimistic
   * running state after reload, reconnect, or a new tab.
   */
  listRunning(): Promise<import("@mcode/contracts/models/turn-runtime").TurnRuntimeSnapshot[]>;
  /** Subscribe this client connection to push events for the active thread. */
  subscribeThread(threadId: string): Promise<void>;
  /** Remove this client connection's push subscription for a thread. */
  unsubscribeThread(threadId: string): Promise<void>;
  /** Replace this connection's complete push subscription set atomically. */
  setThreadSubscriptions?(input: SetThreadSubscriptionsInput): Promise<SetThreadSubscriptionsResult>;
  /** Fetch the current active goal for a thread without starting provider work. */
  getThreadGoal(threadId: string): Promise<GoalLookupResult>;
  /** Clear the current active goal for a thread without sending a chat message. */
  clearThreadGoal(threadId: string): Promise<GoalLookupResult>;
  /**
   * Reports whether the thread holds the user message a send carried, after
   * any admission of that message still running on the server settles.
   */
  confirmMessage(threadId: string, messageId: string): Promise<{ admitted: boolean }>;

  // Thread mutations
  updateThreadTitle(threadId: string, title: string): Promise<boolean>;
  /** Persist per-thread composer settings (reasoning, mode, permission, copilot agent, context window, thinking). */
  updateThreadSettings(
    threadId: string,
    settings: {
      reasoningLevel?: ReasoningLevel;
      interactionMode?: InteractionMode;
      orchestrationMode?: OrchestrationMode;
      permissionMode?: PermissionMode;
      contextWindow?: ContextWindowMode | null;
      thinking?: boolean | null;
      fastMode?: boolean | null;
      devinMode?: DevinMode | null;
      defaultOpenInApp?: string | null;
      autoCompleteOnMerge?: boolean | null;
    },
  ): Promise<boolean>;
  /** Return live waits and unseen settled outcomes across all threads. */
  listAttention(): Promise<import("@mcode/contracts/models/thread-attention").ThreadAttention[]>;
  /** Acknowledge a rendered server sequence up to a settled turn boundary. */
  acknowledgeSeen(threadId: string, throughSequence: number): Promise<import("@mcode/contracts/models/thread-attention").AcknowledgeSeenResult>;
  /** Scan threads for stale or missing PR data and refresh their state. Returns updated PR state
   * for all affected threads. A null prNumber/prStatus signals the PR was cleared (stale data removed). */
  syncThreadPrs(): Promise<{ checked: number }>;

  // Message queries
  /**
   * Fetch persisted messages for a thread, ordered by sequence ascending.
   * @param threadId - Thread to fetch messages from.
   * @param limit - Maximum number of messages to return.
   * @param before - Optional sequence cursor; when provided, only messages with
   *   `sequence < before` are returned, enabling backward pagination.
   *   Omit to fetch the most recent messages.
   * @returns Paginated response with messages array and hasMore flag.
   */
  getMessages(threadId: string, limit: number, before?: number): Promise<PaginatedMessages>;
  /** Fetch persisted messages and grouped narrative for one thread page. */
  loadConversationPage(threadId: string, limit: number, before?: number): Promise<ConversationPage>;
  /** Fetch the canonical descendant roster rooted at one owning parent thread. */
  loadSubagentRoster(
    owningParentThreadId: string,
  ): Promise<SubagentRoster>;
  /** Read the last 32 persisted steps for one roster entry. */
  loadSubagentDetail(owningParentThreadId: string, entryId: string): Promise<SubagentDetail>;
  /** Stop one exact active canonical child turn. */
  stopCanonicalSubagent(
    owningParentThreadId: string,
    childThreadId: string,
  ): Promise<CanonicalSubagentStopResult>;
  /** Fetch one identity-bound and byte-bounded page of older conversation history. */
  loadOlderConversationPage(request: ConversationOlderPageRequest): Promise<ConversationOlderPage>;
  /** Fetch one identity-bound and byte-bounded page of newer conversation history. */
  loadNewerConversationPage(request: ConversationNewerPageRequest): Promise<ConversationNewerPage>;
  /** Fetch only the bounded tail needed for first paint. */
  loadConversationTail?(threadId: string, limit: number): Promise<ConversationTail>;

  // Config
  discoverConfig(workspacePath: string): Promise<Record<string, unknown>>;

  // Meta
  getVersion(): Promise<string>;
  /** Build stage of the running server: dev, nightly, or stable. */
  getStage(): Promise<BuildStage>;

  // File operations (@ file tagging)
  listWorkspaceFiles(workspaceId: string, threadId?: string): Promise<WorkspaceFileList>;
  getWorkspaceFileChanges(workspaceId: string, threadId?: string): Promise<WorkspaceFileChanges>;
  readFileContent(workspaceId: string, relativePath: string, threadId?: string, as?: "text"): Promise<FileReadResult>;
  refreshWorkspaceFiles(workspaceId: string, threadId?: string): Promise<void>;

  // Open-in app actions
  /**
   * List openable apps (editors, file manager) with metadata and detection
   * status, sourced from the desktop main-process registry. Returns an empty
   * list when no desktop bridge is present (web build).
   */
  listOpenInApps(): Promise<OpenInApp[]>;
  /**
   * Open a path in the given registry app, dispatched to the right adapter by
   * the desktop main process, so a single call opens an editor or reveals a path
   * in the file manager. This is the unified seam used by the open-in split
   * button, the file picker, and the `mod+o` shortcut; `appId` is any id from
   * {@link McodeTransport.listOpenInApps}. `line` is honored only by editor apps
   * with a file target. No-op when no desktop bridge is present (web build).
   */
  openIn(appId: string, path: string, line?: number): Promise<void>;

  // GitHub PR
  getBranchPr(branch: string, cwd: string): Promise<PrInfo | null>;

  /** Resolve read and action capabilities for the authenticated pull request viewer. */
  getPullRequestCapabilities(
    request: PullRequestCapabilitiesRequest,
  ): Promise<PullRequestCapabilitiesResult>;
  /** Load one bounded pull request inbox page. */
  listPullRequests(request: PullRequestListRequest): Promise<PullRequestListResult>;
  /** Load one bounded pull request detail, checks, or comments resource. */
  getPullRequestResource(request: PullRequestGetRequest): Promise<PullRequestGetResult>;
  /** Load one bounded pull request Timeline page. */
  getPullRequestTimeline(
    request: PullRequestTimelineRequest,
  ): Promise<PullRequestTimelineResult>;
  /** Load one filtered and bounded page of changed files. */
  getPullRequestFiles(
    request: PullRequestFilesRequest,
  ): Promise<PullRequestFilesResult>;
  /** Load one immutable, snapshot-qualified file patch. */
  getPullRequestPatch(
    request: PullRequestPatchRequest,
  ): Promise<PullRequestPatchResult>;
  /** Prepare or create a local Review task for one pull request. */
  createPullRequestReviewTask(
    request: PullRequestCreateReviewTaskRequest,
  ): Promise<PullRequestCreateReviewTaskResult>;
  /** Resolve the durable pull request link for one thread. */
  getPullRequestReviewLink(
    request: PullRequestReviewLinkRequest,
  ): Promise<PullRequestReviewLinkResult>;
  /** Post one explicit issue comment to a pull request. */
  postPullRequestComment(
    request: PullRequestPostCommentRequest,
  ): Promise<PullRequestPostCommentResult>;
  /** Submit one explicit pull request review and its bounded drafts. */
  submitPullRequestReview(
    request: PullRequestSubmitReviewRequest,
  ): Promise<PullRequestSubmitReviewResult>;
  /** Explicitly change pull request readiness. */
  setPullRequestReadiness(
    request: PullRequestSetReadinessRequest,
  ): Promise<PullRequestSetReadinessResult>;
  /** Explicitly close one pull request. */
  closePullRequest(request: PullRequestCloseRequest): Promise<PullRequestCloseResult>;
  /** Explicitly merge one pull request. */
  mergePullRequest(request: PullRequestMergeRequest): Promise<PullRequestMergeResult>;
  /** Cancel a connection-owned pull request read operation. */
  cancelPullRequestOperation(
    request: PullRequestCancelRequest,
  ): Promise<PullRequestCancelResult>;

  // PR review
  /** Fetch fresh CI check status for a thread (manual refresh). */
  checkStatus(threadId: string, force?: boolean): Promise<ChecksStatus>;

  // Skills
  /** Return a provider capability catalog for one validated discovery context. */
  getProviderCatalog(request: ProviderCatalogRequest): Promise<ProviderCatalogSnapshot>;

  // Terminal (PTY)
  /** List detected certified profiles and persisted custom profiles. */
  terminalProfileList(): Promise<TerminalProfileList>;
  /** Create one validated custom Terminal profile. */
  terminalProfileCreate(input: Omit<TerminalCustomProfile, "id">): Promise<TerminalCustomProfile>;
  /** Update one validated custom Terminal profile. */
  terminalProfileUpdate(input: Omit<TerminalCustomProfile, "id"> & { profileId: string }): Promise<TerminalCustomProfile>;
  /** Delete one unreferenced custom Terminal profile. */
  terminalProfileDelete(profileId: string): Promise<{ deleted: true }>;
  /** Set the global Terminal profile used for new sessions. */
  terminalProfileSetDefault(profileId: TerminalProfileReference): Promise<{ defaultProfileId: TerminalProfileReference }>;
  /** Read the active workspace's explicit Terminal profile override. */
  terminalWorkspacePreferencesGet(workspaceId: string): Promise<TerminalWorkspacePreference>;
  /** Set an explicit workspace Terminal profile override. */
  terminalWorkspacePreferencesUpdate(workspaceId: string, profileId: TerminalProfileReference): Promise<TerminalWorkspacePreference>;
  /** Remove an explicit workspace override so it inherits the global profile. */
  terminalWorkspacePreferencesReset(workspaceId: string): Promise<{ reset: true }>;
  /** Restore Terminal defaults while preserving custom profiles. */
  terminalPreferencesReset(workspaceId?: string): Promise<{ reset: true }>;
  /** Apply safe Terminal presentation, behavior, or accessibility preferences. */
  terminalPreferencesUpdate(input: TerminalPreferencesUpdate): Promise<TerminalPreferencesResult>;
  /** Report the Terminal backend and version selected for the current server boot. */
  terminalCapabilities(): Promise<TerminalBackendCapabilities>;
  /** Retrieve bounded, content-free Terminal diagnostics for recovery support. */
  terminalDiagnosticsGetBundle?: () => Promise<import("@mcode/contracts/models/terminal-diagnostics").TerminalDiagnosticsBundle>;
  /** Fetch the bounded, content-free diagnostics bundle through the selected client. */
  terminalDiagnostics(): Promise<import("@mcode/contracts/models/terminal-diagnostics").TerminalDiagnosticsBundle>;
  /** Create a PTY, optionally closing an exited or failed record before starting its replacement. */
  terminalCreate(threadId: string, replacesSessionId?: string): Promise<import("@mcode/contracts/ws/terminal-legacy").LegacyTerminalCreateResult>;
  /** Write data (keystrokes) to a PTY. */
  terminalWrite(ptyId: string, data: string): Promise<void>;
  /** Resize a PTY to the given dimensions. */
  terminalResize(ptyId: string, cols: number, rows: number): Promise<void>;
  /** Kill a single PTY by ID. */
  terminalKill(ptyId: string): Promise<void>;
  /** Request the server to stop draining a PTY. Idempotent. */
  terminalPause(ptyId: string): Promise<void>;
  /** Request the server to resume a paused PTY. Idempotent. */
  terminalResume(ptyId: string): Promise<void>;
  /** Subscribe one renderer controller to its selected Terminal attachment. */
  terminalSubscribe(
    ptyId: string,
    subscription: import("@/features/terminal/adapters/terminal-client").TerminalClientSubscription,
  ): () => void;
  /** Detach one renderer because its shell is being replaced. */
  terminalDetachForSwitch(
    ptyId: string,
    checkpoint?: Promise<
      { readonly seq: number; readonly data: string } | undefined
    >,
  ): Promise<void>;
  /** Deliver a reconnect gap through the selected Terminal client. */
  terminalNotifyReconnectGap(ptyId: string): void;
  /** Kill all PTYs attached to a thread. */
  terminalKillByThread(threadId: string): Promise<void>;
  /**
   * Reattach to a PTY after a WebSocket reconnect.
   * The server replays any buffered output with seq > lastSeq as binary frames
   * before returning. Returns gapped=true when eviction means output was lost.
   */
  terminalReattach(
    ptyId: string,
    lastSeq: number,
    cold?: boolean,
  ): Promise<
    | { mode: "delta"; replayThrough?: number }
    | {
        mode: "checkpoint";
        checkpoint: string;
        checkpointThrough: number;
        replayThrough?: number;
      }
    | { mode: "reset"; discardThrough: number }
  >;
  /** Save a bounded serialized xterm state for a later cold renderer mount. */
  terminalCheckpoint(
    ptyId: string,
    seq: number,
    data: string,
  ): Promise<{ accepted: boolean }>;
  /** List retained terminal records, including exited processes, during client hydration. */
  terminalListActive(): Promise<import("@mcode/contracts/ws/terminal-legacy").LegacyTerminalRecord[]>;
  /** Check whether a PTY has non-shell child processes running. */
  terminalHasChildren(ptyId: string): Promise<{ hasChildren: boolean }>;
  /** Track the last seq number received for a PTY, used during reconnect reattach. */
  ptySetLastSeq(ptyId: string, seq: number): void;
  /** Remove the last-seq tracking entry for a PTY. Call on component unmount. */
  ptyDeleteLastSeq(ptyId: string): void;

  // Tool call records
  /** Fetch persisted tool call records for a message. */
  listToolCallRecords(messageId: string): Promise<ToolCallRecord[]>;
  /** Fetch child tool call records for a parent tool call. */
  listToolCallRecordsByParent(parentToolCallId: string): Promise<ToolCallRecord[]>;
  /** Fetch the full persisted narrative (tools, thoughts, hooks, approval receipts) for an assistant message. */
  listNarrative(messageId: string): Promise<{
    tools: ToolCallRecord[];
    thoughts: ThoughtSegmentRecord[];
    hooks: HookExecutionRecord[];
    approvals: import("@mcode/contracts/models/approval-receipt").ApprovalReceiptRecord[];
  }>;
  /** Fetch one bounded, server-ordered narrative window. */
  loadTurn(
    threadId: string,
    range?: import("@mcode/contracts/models/narrative-entry").TurnRange,
  ): Promise<import("@mcode/contracts/models/narrative-entry").NarrativeEntry[]>;

  /** Fetch persisted task list for a thread (TodoWrite / Task* tool family). */
  getThreadTasks(threadId: string): Promise<Array<{ id?: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; activeForm?: string; group?: string }> | null>;

  /** Fetch persisted plans for a thread (hydration on page load). */
  getPlanSnapshot(threadId: string): Promise<import("@mcode/contracts/models/plan").PlanSnapshot>;
  /** Save a plan comment; the client-chosen id makes a retried create return the same comment. */
  createPlanComment(payload: import("@mcode/contracts/models/plan").PlanCommentCreate): Promise<import("@mcode/contracts/models/plan").PlanComment>;
  /** Replace a saved comment's note. */
  updatePlanComment(payload: import("@mcode/contracts/models/plan").PlanCommentUpdate): Promise<import("@mcode/contracts/models/plan").PlanComment>;
  /** Resolve or reopen a saved comment. */
  setPlanCommentStatus(payload: import("@mcode/contracts/models/plan").PlanCommentSetStatus): Promise<import("@mcode/contracts/models/plan").PlanComment>;
  /** Delete a saved comment. Deleting a missing comment succeeds. */
  deletePlanComment(payload: import("@mcode/contracts/models/plan").PlanCommentDelete): Promise<void>;
  /** Fork the latest plan version into a draft, or save into an existing draft at its revision. */
  savePlanVersion(payload: import("@mcode/contracts/models/plan").PlanSaveVersion): Promise<import("@mcode/contracts/models/plan").PlanVersion>;
  /** Admit a durable request to implement a plan version in its own thread. Replays with the same requestId return the stored outcome. */
  implementPlan(payload: import("@mcode/contracts/models/plan").PlanImplement): Promise<import("@mcode/contracts/models/plan").PlanImplementReceipt>;

  // Snapshots
  /** Get a unified diff for a specific file from a turn snapshot. */
  getSnapshotDiff(snapshotId: string, filePath?: string, maxLines?: number): Promise<ReviewFileDiffResult>;
  /** Read the active or settled latest turn comparison, or one picked turn when `messageId` is given. */
  getTurnDiffComparison(threadId: string, messageId?: string, options?: DiffReadOptions): Promise<ReviewComparisonResult>;
  /** Read a file from one exact native or fallback comparison. */
  getTurnDiffFile(threadId: string, comparisonId: string, filePath: string, options?: DiffReadOptions): Promise<ReviewFileDiffResult>;
  /** Get per-file change classification and line counts for a turn snapshot. */
  getSnapshotDiffStats(snapshotId: string): Promise<DiffStats[] | Exclude<ReviewComparisonResult, { status: "ready" }>>;
  /** Run garbage collection on expired snapshot refs. */
  cleanupSnapshots(): Promise<{ removed: number }>;
  /** List all turn snapshots for a thread, ordered by creation time. */
  listSnapshots(threadId: string): Promise<TurnSnapshot[]>;
  /** Get cumulative diff across all turns for a thread. Implemented in Phase 3. */
  listReviewTurns(threadId: string): Promise<ReviewTurn[]>;
  /** Plan a turn revert without touching the worktree. */
  previewTurnRevert(threadId: string, messageId: string, scope: TurnRevertScope): Promise<TurnRevertPreview>;
  /** Apply a previewed revert. Resending the same `requestId` replays the first outcome. */
  applyTurnRevert(params: { threadId: string; messageId: string; scope: TurnRevertScope; previewToken: string; requestId: string }): Promise<TurnRevertResult>;
  /** Undo a committed revert. Resending the same `requestId` replays the first outcome. */
  undoTurnRevert(threadId: string, revertId: string, requestId: string): Promise<TurnRevertResult>;
  /** With `afterSequence`, reads only whole turns that settled after that message sequence. */
  getCumulativeDiff(threadId: string, filePath?: string, maxLines?: number, afterSequence?: number, options?: DiffReadOptions): Promise<ReviewFileDiffResult>;
  /**
   * Return authoritative net file stats from the first turn ref to the final turn ref. With
   * `afterSequence`, only whole turns that settled after that message sequence count.
   */
  getCumulativeDiffStats(threadId: string, afterSequence?: number, options?: DiffReadOptions): Promise<ReviewComparisonResult>;
  /** Get commit log for a workspace branch. Pass threadId so the server runs git from the thread's worktree path. */
  getGitLog(
    workspaceId: string,
    branch?: string,
    limit?: number,
    baseBranch?: string,
    threadId?: string,
    options?: { skip?: number; includeStats?: boolean },
  ): Promise<GitCommit[]>;
  /** Get unified diff for a specific git commit. Implemented in Phase 4. */
  getCommitDiff(workspaceId: string, sha: string, filePath?: string, maxLines?: number, options?: DiffReadOptions): Promise<string>;
  /** Get the list of files changed in a specific git commit. */
  getCommitFiles(workspaceId: string, sha: string): Promise<string[]>;
  /** Get the unified diff for the working tree (staged or unstaged), optionally per file. Pass threadId to read the thread's worktree. */
  getWorkingTreeDiff(workspaceId: string, staged: boolean, filePath?: string, maxLines?: number, threadId?: string, untracked?: boolean, previousPath?: string, options?: DiffReadOptions): Promise<string>;
  /** Read a file's contents at a revision. `ref` follows `git show` rules; "" reads the staged index blob and "A...B" reads at the merge base. Pass threadId to read the thread's worktree. Rejects when the ref or file is absent. */
  readFileAtRef(workspaceId: string, ref: string, filePath: string, threadId?: string): Promise<string>;
  /** Get the unified diff between two refs (`base...target`, three-dot), optionally per file. Omit base/target to use the detected default branch → HEAD. Pass threadId to read the thread's worktree. */
  getBranchDiff(workspaceId: string, base?: string, target?: string, filePath?: string, maxLines?: number, threadId?: string, options?: DiffReadOptions): Promise<string>;
  /** Resolve qualified default operands in the thread's checkout. */
  getBranchComparison(workspaceId: string, threadId?: string): Promise<BranchComparison>;
  /** Search and page the Commit view's range: the commits since the checkout forked from its base. */
  searchCommits(params: import("@mcode/contracts/git").GitSearchCommitsParams): Promise<import("@mcode/contracts/git").GitSearchCommitsResult>;
  /** Resolve a workspace or thread checkout's origin remote into a normalized web URL and repository label. */
  getRemoteUrl(workspaceId: string, threadId?: string): Promise<GitRemoteUrl>;
  /** Probe dirty state and available Review comparisons. */
  getReviewState(workspaceId: string, threadId?: string): Promise<import("@mcode/contracts/models/review-comparison").ReviewState>;
  /** Resolve file metadata and totals for one Review comparison in one request. */
  getReviewComparison(params: {
    workspaceId: string;
    view: "unstaged" | "staged" | "branch" | "commit" | "uncommitted";
    base?: string;
    compare?: string;
    sha?: string;
    threadId?: string;
    ignoreWhitespace?: boolean;
  }): Promise<import("@mcode/contracts/models/review-comparison").ReviewComparisonResult>;

  /** Draft a commit subject and body for the selected paths with the utility model. */
  generateCommitMessage(
    params: import("@mcode/contracts/git-commit").GitGenerateCommitMessageParams,
  ): Promise<import("@mcode/contracts/git-commit").GitGenerateCommitMessageResult>;
  /** Commit the selected files once per `requestId`, then optionally push. Replaying a `requestId` returns the stored outcome. */
  commitChanges(params: import("@mcode/contracts/git-commit").GitCommitParams): Promise<import("@mcode/contracts/git-commit").GitCommitResult>;

  // GitHub PR (advanced)
  /** Push a branch to the remote. */
  push(
    workspaceId: string,
    branch: string,
    threadId?: string,
  ): Promise<{ success: boolean }>;

  /** Generate an AI-powered PR draft from commit history and conversation context. */
  generatePrDraft(workspaceId: string, threadId: string, baseBranch: string): Promise<PrDraft>;

  /** Push the branch (if needed) and create a GitHub PR. */
  createPr(
    workspaceId: string,
    threadId: string,
    title: string,
    body: string,
    baseBranch: string,
    isDraft: boolean,
  ): Promise<CreatePrResult>;

  // Settings
  /** Fetch the full settings object from the server. */
  getSettings(): Promise<Settings>;
  /** Update settings with a deep-partial merge. Returns full merged settings. */
  updateSettings(partial: PartialSettings): Promise<Settings>;

  // Provider models
  /** Fetch dynamically discovered models from a provider (e.g. Copilot). */
  listProviderModels(providerId: string): Promise<ProviderModelInfo[]>;
  /** Fetch the provider-native mode ids this account advertises, or null when unknown. */
  listProviderModes(providerId: string): Promise<string[] | null>;
  /** Fetch current usage/quota state for a provider. */
  getProviderUsage(providerId: string): Promise<ProviderUsageInfo>;
  /** Fetch the current availability snapshot for all registered providers. */
  listProviderAvailability(): Promise<ProviderAvailability[]>;
  /** Fetch sign-in and rate-limit state for enabled providers; `force` bypasses the server's 10-minute cache. */
  listProviderStatus(force?: boolean): Promise<ProviderStatus[]>;
  /** Update a provider's npm-installed CLI to the latest release; resolves with the refreshed status. */
  updateProviderCli(providerId: ProviderId): Promise<ProviderStatus>;
  /** Mark a provider's new-model announcements as seen; the server pushes the updated status. */
  acknowledgeProviderModels(providerId: ProviderId): Promise<void>;

  /** Generate a stateless one-line conversational recap from bounded messages. */
  generateRecap(
    threadId: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    previousRecap: string | null,
  ): Promise<{ text: string }>;

  // Memory pressure
  /** Notify server of window background/foreground state for memory management. */
  setBackground(background: boolean): Promise<void>;

  /**
   * Read the latest v2 handoff audit for a thread.
   * Returns null when no v2 audit has been written for the thread.
   */
  readLatestHandoff(threadId: string): Promise<{
    markdown: string;
    meta: HandoffAuditMetadata;
  } | null>;
}
