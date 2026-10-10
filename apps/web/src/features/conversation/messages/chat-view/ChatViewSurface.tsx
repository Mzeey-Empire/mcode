import { useEffect, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { GitFork } from "lucide-react";
import type { Message, RecoveryIncident, SelectedTextComment, ThreadStartup, ThreadStartupKind } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { Notice } from "@/components/ui/notice";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describeCliError, isCliError } from "@/components/chat/cli-error";
import { CollapsibleError } from "@/components/chat/CollapsibleError";
import { ConversationHoldOverlay } from "@/components/chat/ConversationHoldOverlay";
import { HandoffDocDialog, useHandoffFallback } from "@/components/chat/handoff-fallback";
import { HeaderActions } from "@/components/chat/HeaderActions";
import { InterruptedSessionsBanner } from "@/components/chat/InterruptedSessionsBanner";
import { PlanQuestionWizard } from "@/components/chat/PlanQuestionWizard";
import { ThreadTitleEditor } from "@/components/chat/ThreadTitleEditor";
import { CanvasHeader } from "@/components/shell/CanvasHeader";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { PRIMARY_CONTENT_RAIL_CLASS } from "@/lib/layout-rails";
import { useThreadDraftStore, type ThreadDraftPayload } from "@/stores/threadDraftStore";
import { OverviewLayer } from "@/features/thread-overview/overview-layer";
import { ProjectAutomaticSetupCard, useProjectAutomaticSetup } from "@/features/projects/environment";
import { ProjectCommandApprovalDialog } from "@/features/projects/environment/ProjectCommandApprovalDialog";
import { StartupStepsTrail, editStartupSetupScript, openStartupSetupTerminal, useFirstSendMotion, useThreadStartup } from "@/features/thread-startup";
import { useThreadStartupLookup, useThreadStartupStore } from "@/features/thread-startup/state/thread-startup-store";
import { type WorkspaceThread, type ClientPreparingContext } from "@/lib/workspace-thread";
import type { PendingStartup } from "@/features/projects/state/workspaceStore";
import type { SubagentRosterTarget } from "../../narrative";
import { Composer } from "../../composer/Composer";
import { SavingDelayedDialog } from "../../saving/SavingDelayedDialog";
import { TurnSavingNotice } from "../../saving/TurnSavingNotice";
import { MessageBubble } from "../MessageBubble";
import { MessageList, type SelectedTextCommentSourceNavigationRequest } from "../MessageList";
import { tryGetConversationResidency } from "../../residency/conversation-residency";
import type { ChatViewState } from "./useChatViewState";
import { NewThreadStartColumn } from "./NewThreadStartColumn";

/** Actions that the visual chat surface routes to stores, transport, and composer state. */
export interface ChatViewInteractions {
  /** Opens inline fork mode from a transcript message. */
  onBranch: (messageId: string) => void;
  /** Starts a selected-text comment in the composer. */
  onSelectedTextComment: (comment: SelectedTextComment) => void;
  /** Removes one saved selected-text comment from the active Composer draft. */
  onDeleteSelectedTextComment: (comment: SelectedTextComment) => void;
  /** Clears a consumed selected-text comment deletion. */
  onSelectedTextCommentDeletionConsumed: () => void;
  /** Clears the composer selected-text comment after it is consumed. */
  onSelectedTextCommentConsumed: () => void;
  /** Stores transcript editor changes in the active ComposerDraft. */
  onSelectedTextCommentEditorChange: (editor: SelectedTextCommentEditorDraft | undefined) => void;
  /** Clears a consumed transcript editor update. */
  onSelectedTextCommentEditorChangeConsumed: () => void;
  /** Starts transcript-owned navigation for one aggregate card source. */
  onOpenSelectedTextCommentSource: (comment: SelectedTextComment) => void;
  /** Starts transcript-owned navigation that opens one source marker's editor. */
  onOpenSelectedTextCommentEditor: (comment: SelectedTextComment) => void;
  /** Installs a source-anchored editor after its active request reconstructs canonically. */
  onSelectedTextCommentSourceOpened: (request: SelectedTextCommentSourceNavigationRequest) => void;
  /** Installs a card-anchored fallback when its active aggregate-card request fails. */
  onSelectedTextCommentSourceUnavailable: (request: SelectedTextCommentSourceNavigationRequest) => void;
  /** Moves a restored source editor to its card when source loading fails. */
  onSelectedTextCommentEditorSourceUnavailable: (editor: SelectedTextCommentEditorDraft) => void;
  /** Stops the active agent after saving has stalled. */
  onStopSafely: () => Promise<void>;
  /** Continues a stalled turn without saving its recovery state. */
  onContinueWithoutSaving: () => Promise<void>;
  /** Dismisses the active CLI error. */
  onDismissCliError: () => void;
  /** Opens the model settings section. */
  onOpenSettings: () => void;
  /** Changes the current title. */
  onSaveTitle: (title: string) => void;
  /** Leaves inline fork mode. */
  onExitForkMode: () => void;
}

/** Recovery banner state and actions for the active conversation. */
export interface ChatRecoveryBannerState {
  /** Restart-scoped incident returned by the server, when visible. */
  incident: RecoveryIncident | null;
  /** Dismisses one incident for the browser app session. */
  onDismiss: (incidentId: string) => void;
  /** Retries each exact turn in the visible incident. */
  onRetry: (executionIds: readonly string[]) => Promise<void>;
}

/** Props for the root chat visual surface. */
export interface ChatViewSurfaceProps {
  /** Current selection and message display state. */
  state: ChatViewState;
  /** Chat UI actions. */
  interactions: ChatViewInteractions;
  /** State used by recovery banners. */
  recovery: ChatRecoveryBannerState;
  /** Current inline title editing state. */
  editingThreadId: string | null;
  /** Updates inline title editing state. */
  onEditingThreadIdChange: (threadId: string | null) => void;
  /** Pending composer comment from selected transcript text. */
  pendingSelectedTextComment: SelectedTextComment | null;
  /** Pending deletion for one saved transcript comment. */
  pendingSelectedTextCommentDeletion: SelectedTextComment | null;
  /** Pending transcript editor mutation for the active ComposerDraft. */
  pendingSelectedTextCommentEditor?: { editor: SelectedTextCommentEditorDraft | undefined };
  /** Restored open-editor state for the active ComposerDraft. */
  selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
  /** Source navigation request for the active virtualized transcript. */
  selectedTextCommentSourceNavigation?: SelectedTextCommentSourceNavigationRequest;
  /** Cards whose source failed to load or reconstruct for this active thread. */
  unavailableSelectedTextCommentIds: readonly string[];
  /** Opens a selected canonical child through the composition root. */
  onSubagentSelect?: (id: string, target: SubagentRosterTarget) => void;
  /** Opens the owning thread's Subagents roster for aggregate activity. */
  onOpenSubagents?: (target: SubagentRosterTarget) => void;
  /** Error dismissed within the active thread. */
  dismissedError: string | null;
}

/** Startup kind for placeholder rows drawn before the server returns the record. */
function startupKind(context: ClientPreparingContext | undefined, startup: ReturnType<typeof useThreadStartup>): ThreadStartupKind {
  if (startup) return startup.kind;
  if (context === "new-existing-worktree" || context === "branch-existing-worktree") return "attached-worktree";
  if (context === "new-worktree" || context === "branch-worktree") return "managed-worktree";
  return "direct";
}

function showsAuthoritativeCancellation(thread: WorkspaceThread, startup: ReturnType<typeof useThreadStartup>): boolean {
  return Boolean(thread.clientError) && startup?.state === "cancelled";
}

/** Recovery actions for a cancelled startup on a durable thread. */
function CancelledStartupActions({ thread, startup }: { thread: WorkspaceThread; startup: NonNullable<ReturnType<typeof useThreadStartup>> }) {
  const startOver = async () => {
    // The vetoed message survives only in the restored draft (already consumed
    // by the in-shell composer) or the husk thread's title. Set the prefill
    // after delete: pendingPrefill is consumed by whichever composer is mounted
    // when it lands, and the in-shell composer would eat it.
    const prefill = useComposerDraftStore.getState().getDraft(thread.id)?.input || thread.title;
    await useWorkspaceStore.getState().deleteThread(thread.id, thread.mode === "worktree");
    if (prefill) useComposerDraftStore.getState().setPendingPrefill(prefill);
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="compact"
        onClick={() => { void startOver().catch(() => undefined); }}
      >
        Start over
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="compact"
        onClick={() => useThreadStartupStore.getState().dismissStartup(startup.startupId)}
      >
        Keep thread
      </Button>
    </>
  );
}

/** The thread's startup trail with the recovery actions for its current state. */
function ThreadStartupTrail({ thread, startup, pendingStartup, actions }: {
  readonly thread: WorkspaceThread;
  readonly startup: ReturnType<typeof useThreadStartup>;
  readonly pendingStartup: PendingStartup | undefined;
  readonly actions?: ReactNode;
}) {
  const threadId = startup?.threadId;
  return (
    <StartupStepsTrail
      startup={startup}
      startupId={pendingStartup?.startupId ?? startup?.startupId}
      kind={startupKind(pendingStartup?.context, startup)}
      actions={startup?.state === "cancelled" ? <CancelledStartupActions thread={thread} startup={startup} /> : actions}
      onOpenTerminal={threadId ? () => { void openStartupSetupTerminal(thread.workspace_id, threadId); } : undefined}
      onEditScript={threadId ? () => editStartupSetupScript(thread.workspace_id, threadId) : undefined}
    />
  );
}

/** One row laid out like a MessageList row, so the durable thread opens without a jump. */
function PreparingTranscriptRow({ children, ref }: { readonly children: ReactNode; readonly ref?: Ref<HTMLDivElement> }) {
  return <div ref={ref} className="w-full px-4 py-2 sm:px-8"><div className={cn(PRIMARY_CONTENT_RAIL_CLASS, "min-w-0")}>{children}</div></div>;
}

/** Whether a resolved startup is stuck in a state the automatic-setup card can recover from. */
function startupNeedsSetupRecovery(startup: ReturnType<typeof useThreadStartup>): boolean {
  return startup?.state === "blocked" || startup?.state === "failed" || startup?.state === "interrupted";
}

/**
 * The thread surface's preparing variant, shown while the server creates or starts the thread.
 *
 * It mounts no conversation hooks because the selected id may still be a client placeholder.
 */
function PreparingThreadSurface({
  thread,
  state,
  startup,
  pendingStartup,
}: {
  thread: WorkspaceThread;
  state: ChatViewState;
  startup: ReturnType<typeof useThreadStartup>;
  pendingStartup: PendingStartup | undefined;
}) {
  const echoedStartup = useEchoedPendingStartup(thread, pendingStartup);
  const motion = useFirstSendMotion(thread.id);
  const needsSetupRecovery = startupNeedsSetupRecovery(startup);
  const automaticSetup = useProjectAutomaticSetup(
    thread.id,
    needsSetupRecovery && thread.mode === "worktree" && thread.worktree_managed === true,
  );
  return (
    <div className="flex h-full flex-col bg-background" data-testid="thread-preparing-shell">
      <ThreadHeader state={state} />
      <div className="min-h-0 flex-1 overflow-y-auto pt-4">
        <PreparingTranscriptRow ref={motion.message}>
          <MessageBubble message={preparingUserMessage(thread, echoedStartup)} />
        </PreparingTranscriptRow>
        <PreparingTranscriptRow ref={motion.steps}>
          {thread.clientError && !showsAuthoritativeCancellation(thread, startup)
            ? <CollapsibleError error={thread.clientError} onRetry={() => { void useWorkspaceStore.getState().retryPreparingThread(thread.id); }} onDismiss={() => useWorkspaceStore.getState().dismissPreparingThread(thread.id)} />
            : <ThreadStartupTrail thread={thread} startup={startup} pendingStartup={pendingStartup} actions={<StartupAutomaticSetupActions automaticSetup={automaticSetup} thread={thread} startup={startup} pendingStartup={pendingStartup} />} />}
        </PreparingTranscriptRow>
      </div>
      <div ref={motion.composer}>
        <Composer threadId={thread.id} workspaceId={state.activeWorkspaceId ?? undefined} />
      </div>
    </div>
  );
}

// A completed startup clears its pending entry, which can happen before the durable message arrives or the placeholder id is replaced.
// The surface keeps echoing that startup's first message while the selected thread still owns it, so the bubble does not fall back to the title.
// Any other terminal state either returns the message to the composer or stops after it was persisted, so no echo is needed.
function useEchoedPendingStartup(thread: WorkspaceThread, pendingStartup: PendingStartup | undefined): PendingStartup | undefined {
  const [retained, setRetained] = useState(pendingStartup ? { threadId: thread.id, pendingStartup } : undefined);
  const retainedRecord = useThreadStartupStore((s) => retained ? s.recordsByStartupId[retained.pendingStartup.startupId] : undefined);
  if (pendingStartup && pendingStartup !== retained?.pendingStartup) setRetained({ threadId: thread.id, pendingStartup });
  if (pendingStartup) return pendingStartup;
  return retained && threadOwnsCompletedEcho(thread, retained.threadId, retainedRecord) ? retained.pendingStartup : undefined;
}

function threadOwnsCompletedEcho(thread: WorkspaceThread, echoThreadId: string, record: ThreadStartup | undefined): boolean {
  return record?.state === "completed" && (echoThreadId === thread.id || record.threadId === thread.id);
}

// The durable bubble's footer and message parts add height, so the preparing surface draws the same bubble to keep the trail still at hand-off.
function preparingUserMessage(thread: WorkspaceThread, pendingStartup: PendingStartup | undefined): Message {
  return {
    id: `preparing-${thread.id}`,
    thread_id: thread.id,
    role: "user",
    // An attachment-only first message has empty text, and the durable bubble keeps it empty.
    content: pendingStartup ? pendingStartup.queuedMessage : thread.title,
    tool_calls: null,
    files_changed: null,
    cost_usd: null,
    tokens_used: null,
    timestamp: thread.created_at,
    sequence: 0,
    attachments: null,
    ...pendingStartup?.queuedMessageParts,
  };
}

/** Renders the selected-row shell when no matching workspace thread remains. */
function MissingThreadSurface() {
  return (
    <div className="flex h-full flex-col bg-background">
      <CanvasHeader />
      <div className="flex flex-1 items-center justify-center"><div className="text-center"><h2 className="text-lg font-medium text-ink">Select a thread</h2><p className="mt-1 text-sm text-muted">Choose a thread from the sidebar or create a new one.</p></div></div>
    </div>
  );
}

/** Title editing for a durable thread; a preparing thread has nothing to rename yet. */
interface ThreadHeaderRename {
  readonly editingThreadId: string | null;
  readonly onEditingThreadIdChange: (threadId: string | null) => void;
  readonly onSaveTitle: (title: string) => void;
}

/** Renders the thread header for both surface variants; the preparing variant omits `rename` and has no actions yet. */
function ThreadHeader({ state, rename }: { state: ChatViewState; rename?: ThreadHeaderRename }) {
  const thread = state.activeThread!;
  return (
    <CanvasHeader className="border-b border-border">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {rename ? (
          // Double-click renames, so the title must not hand the gesture to the window.
          <div data-testid="chat-header-title" onDoubleClick={() => rename.onEditingThreadIdChange(thread.id)} className="window-no-drag cursor-text">
            <ThreadTitleEditor title={thread.title} isEditing={rename.editingThreadId === thread.id} onSave={rename.onSaveTitle} onCancel={() => rename.onEditingThreadIdChange(null)} />
          </div>
        ) : (
          <span data-testid="chat-header-title" className="text-fade text-sm font-medium">{thread.title}</span>
        )}
        {thread.parent_thread_id && state.parentThreadExists && (
          <Tooltip>
            <TooltipTrigger render={<button type="button" onClick={() => state.setActiveThread(thread.parent_thread_id!)} className="flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs font-medium text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"><GitFork size={10} /><span>Forked</span></button>} />
            <TooltipContent side="bottom" className="text-xs">Go to parent thread</TooltipContent>
          </Tooltip>
        )}
      </div>
      {rename ? <HeaderActions thread={thread} threadPaneWidth={state.threadPaneWidth} /> : null}
    </CanvasHeader>
  );
}

/** Renders restart recovery and worktree warning banners. */
function ActiveThreadBanners({ state, recovery }: { state: ChatViewState; recovery: ChatRecoveryBannerState }) {
  const thread = state.activeThread!;
  return (
    <>
      {recovery.incident && <div className="px-4 pt-2"><InterruptedSessionsBanner incident={recovery.incident} onDismiss={() => recovery.onDismiss(recovery.incident!.id)} onRetry={recovery.onRetry} /></div>}
      {thread.clientWarnings?.length ? <div className="mx-auto w-full max-w-3xl px-4 pt-2"><Notice tone="warning" collapsible title="Post-checkout hook encountered an error" detail={<WarningOutput lines={thread.clientWarnings} />} onDismiss={() => useWorkspaceStore.getState().dismissWarnings(thread.id)} dismissLabel="Dismiss warning" /></div> : null}
    </>
  );
}

/** Command output in the Paper code inset. */
function WarningOutput({ lines }: { lines: readonly string[] }) {
  return <div className="space-y-2">{lines.map((line, i) => <pre key={i} className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background p-3 font-mono text-caption text-muted">{line}</pre>)}</div>;
}

/** Fork-thread notice for a handoff the local builder produced. */
function HandoffFallbackNotice({ threadId }: { threadId: string }) {
  const fallback = useHandoffFallback(threadId);
  const [docOpen, setDocOpen] = useState(false);
  if (!fallback) return null;
  return (
    <>
      <Notice tone={fallback.copy.tone} title={fallback.copy.title} detail={fallback.copy.detail} action={{ label: "View doc", onClick: () => setDocOpen(true), emphasis: "neutral" }} onDismiss={fallback.dismiss} data-testid="handoff-fallback-notice" className="mx-4 mt-2" />
      <HandoffDocDialog threadId={threadId} open={docOpen} onOpenChange={setDocOpen} />
    </>
  );
}

/** Provider CLI setup notice above the composer. */
function CliErrorNotice({ error, onDismiss, onOpenSettings }: { error: string; onDismiss: () => void; onOpenSettings: () => void }) {
  const { headline, installCommand, settingsHint } = describeCliError(error);
  const detail = installCommand || settingsHint ? (
    <div className="space-y-2">
      {settingsHint ? <p>{settingsHint}</p> : null}
      {installCommand ? (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-md bg-background p-3 font-mono text-caption text-muted">{installCommand}</code>
          <CopyButton text={installCommand} label="Copy command" />
        </div>
      ) : null}
    </div>
  ) : undefined;
  return <Notice tone="warning" title={headline} detail={detail} action={settingsHint ? { label: "Open Settings", onClick: onOpenSettings, emphasis: "neutral" } : undefined} onDismiss={onDismiss} dismissLabel="Dismiss error" className="mx-3 mb-2" />;
}

type ConversationStage = "hold" | "transition" | "error" | "messages";

/** Checks whether a retained outgoing transcript must remain visible. */
function hasConversationHold(state: ChatViewState): boolean {
  return state.displayHoldThreadId !== null && !state.targetPaintable;
}

/** Checks whether the selected conversation still needs its hydration shell. */
function hasConversationTransition(state: ChatViewState): boolean {
  const conversationLoading = state.hydratedThreadId !== state.activeThreadId || state.historyLoading;
  return conversationLoading && !state.targetPaintable && !state.isAgentRunning;
}

/** Checks whether a hydration failure replaces the transcript stage. */
function hasFullConversationError(state: ChatViewState): boolean {
  return conversationErrorLabel(state) === LOAD_ERROR_LABEL
    && state.messageCount === 0
    && !state.isAgentRunning;
}

const LOAD_ERROR_LABEL = "Could not refresh conversation";

/** Names the failed action for a conversation error; turn errors already render in the transcript. */
function conversationErrorLabel(state: ChatViewState): string | null {
  if (!isConversationError(state.sessionError) || state.sessionErrorSource === "turn") return null;
  return state.sessionErrorSource === "send" ? "Could not send message" : LOAD_ERROR_LABEL;
}

/** Checks whether an error belongs in the conversation rather than the CLI banner. */
function isConversationError(error: string | null): boolean {
  return error !== null && !isCliError(error);
}

/** Checks whether an undisposed CLI error should remain visible. */
function isVisibleCliError(error: string | null, dismissedError: string | null): boolean {
  return error !== null && isCliError(error) && error !== dismissedError;
}

/** Selects the visible conversation stage while MessageList remains the scroll owner. */
function getConversationStage(state: ChatViewState): ConversationStage {
  if (hasConversationHold(state)) return "hold";
  if (hasConversationTransition(state)) return "transition";
  if (hasFullConversationError(state)) return "error";
  return "messages";
}

/** Renders one retained transcript and holds a display lease while it is hidden. */
function KeptAliveTranscript({
  threadId,
  selected,
  visible,
  leadingContent,
  afterFirstUserContent,
  messageListProps,
}: {
  threadId: string;
  selected: boolean;
  visible: boolean;
  leadingContent: ReactNode;
  afterFirstUserContent: ReactNode;
  messageListProps: Omit<ComponentProps<typeof MessageList>, "leadingContent" | "afterFirstUserContent" | "displayThreadId">;
}) {
  // The lease keeps a hidden transcript's record resident and self-heals it after
  // cache eviction; releasing on selection is a no-op while the thread is current.
  useEffect(() => {
    if (selected) return;
    const residency = tryGetConversationResidency();
    if (!residency) return;
    void residency.mountDisplayConversation(threadId);
    return () => residency.unmountDisplayConversation(threadId);
  }, [selected, threadId]);
  // display:none would collapse the virtualized viewport to zero height and make
  // the virtualizer destroy every row, so hidden transcripts stay laid out but
  // unpainted; revealing one is a style flip instead of a DOM rebuild.
  return (
    <div
      className="absolute inset-0"
      style={{ visibility: visible ? "visible" : "hidden" }}
      inert={!visible}
      aria-hidden={!visible}
    >
      <MessageList {...messageListProps} displayThreadId={threadId} leadingContent={leadingContent} afterFirstUserContent={afterFirstUserContent} />
    </div>
  );
}

/** Renders the hold, transition, or error overlay above the retained transcripts. */
function ConversationStageOverlay({ stage, state, thread }: { stage: ConversationStage; state: ChatViewState; thread: WorkspaceThread }) {
  switch (stage) {
    case "hold":
      return <ConversationHoldOverlay targetTitle={thread.title || "Conversation"} />;
    case "transition":
      return <ConversationTransitionState threadId={thread.id} threadTitle={thread.title || "Conversation"} />;
    case "error":
      return <ConversationErrorState error={state.sessionError ?? ""} />;
    default:
      return null;
  }
}

/** Renders retained transcripts and swaps visibility instead of remounting on switches. */
function ConversationStageContent({
  stage,
  state,
  thread,
  leadingContent,
  afterFirstUserContent,
  messageListProps,
}: {
  stage: ConversationStage;
  state: ChatViewState;
  thread: WorkspaceThread;
  leadingContent: ReactNode;
  afterFirstUserContent: ReactNode;
  messageListProps: Omit<ComponentProps<typeof MessageList>, "leadingContent" | "afterFirstUserContent" | "displayThreadId">;
}) {
  const visibleThreadId =
    stage === "hold" ? state.displayHoldThreadId
    : stage === "messages" ? state.activeThreadId
    : null;
  const transcripts = state.recentThreadIds.map((id) => (
    <KeptAliveTranscript
      key={id}
      threadId={id}
      selected={id === state.activeThreadId}
      visible={id === visibleThreadId}
      leadingContent={id === state.activeThreadId ? leadingContent : undefined}
      afterFirstUserContent={id === state.activeThreadId ? afterFirstUserContent : undefined}
      messageListProps={messageListProps}
    />
  ));
  return (
    <div className="relative h-full" aria-busy={stage === "hold" || stage === "transition"}>
      <div className={stage === "messages" ? "relative h-full" : "pointer-events-none relative h-full"} inert={stage !== "messages"}>{transcripts}</div>
      <ConversationStageOverlay stage={stage} state={state} thread={thread} />
    </div>
  );
}

/** Renders the conversation stage without taking over MessageList scrolling. */
function SetupRecoveryActions({ automaticSetup }: { readonly automaticSetup: ReturnType<typeof useProjectAutomaticSetup> }) {
  const retrying = automaticSetup.busy === "retry";
  const continuing = automaticSetup.busy === "continue";
  return (
    <>
      <Button type="button" variant="outline" size="compact" disabled={automaticSetup.busy !== null} onClick={() => { void automaticSetup.retrySetup(); }}>
        {retrying ? <Spinner size={12} aria-hidden /> : null}
        Retry setup
      </Button>
      <Button type="button" variant="outline" size="compact" disabled={automaticSetup.busy !== null} onClick={() => { void automaticSetup.continueWithoutSetup(); }}>
        {continuing ? <Spinner size={12} aria-hidden /> : null}
        Continue without setup
      </Button>
    </>
  );
}

function preserveIncompleteDraft(thread: WorkspaceThread, draft: ThreadDraftPayload["draft"], autoPreviewBranch: string): string {
  const id = useThreadDraftStore.getState().saveDraft({
    workspaceId: thread.workspace_id,
    draft,
    selection: {
      interactionMode: thread.interaction_mode ?? "build",
      permissionMode: thread.permission_mode ?? "full",
      orchestrationMode: thread.orchestration_mode ?? "standard",
      approvalReviewMode: "manual",
      thinking: thread.thinking,
    },
    target: {
      mode: "worktree",
      // An empty branch follows the project's current-else-default branch when the draft reopens.
      branch: thread.base_branch || thread.branch,
      branchSource: "branch",
      customBranchName: "",
      autoPreviewBranch,
      selectedWorktree: null,
    },
  });
  if (!id) throw new Error("Could not keep this draft");
  useComposerDraftStore.getState().removeDraftAfterAttachmentTransfer(thread.id);
  return id;
}

function RemoveIncompleteThreadAction({ thread, pendingStartup }: {
  readonly thread: WorkspaceThread;
  readonly pendingStartup: PendingStartup | undefined;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    const draftStore = useComposerDraftStore.getState();
    const workspace = useWorkspaceStore.getState();
    const draft = draftStore.getDraft(thread.id);
    const prompt = pendingStartup?.queuedMessage || thread.title;
    const threadDraftStore = useThreadDraftStore.getState();
    let savedDraftId: string | null = null;
    setRemoving(true);
    setError(null);
    try {
      if (draft) savedDraftId = preserveIncompleteDraft(thread, draft, workspace.autoPreviewBranch);
      await workspace.deleteThread(thread.id, true);
    } catch (failure) {
      if (savedDraftId && draft) {
        draftStore.saveDraft(thread.id, draft);
        threadDraftStore.removeDraftAfterAttachmentTransfer(savedDraftId);
      }
      setError(String(failure));
      return;
    } finally {
      setRemoving(false);
    }
    if (savedDraftId) workspace.openThreadDraft(thread.workspace_id, savedDraftId);
    else if (prompt) draftStore.setPendingPrefill(prompt);
  };
  return (
    <>
      <Button type="button" variant="outline" size="compact" disabled={removing} onClick={() => { void remove(); }}>
        Remove incomplete thread
      </Button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}

function StartupAutomaticSetupActions({ automaticSetup, thread, startup, pendingStartup }: {
  readonly automaticSetup: ReturnType<typeof useProjectAutomaticSetup>;
  readonly thread: WorkspaceThread;
  readonly startup: ReturnType<typeof useThreadStartup>;
  readonly pendingStartup: PendingStartup | undefined;
}) {
  if (startup?.threadId === thread.id
    && thread.mode === "worktree" && thread.worktree_managed
    && (startup.state === "failed" || startup.state === "interrupted")
    && startup.phase !== "agent"
    && automaticSetup.snapshotLoaded && !automaticSetup.snapshot.attempt) {
    return <RemoveIncompleteThreadAction thread={thread} pendingStartup={pendingStartup} />;
  }
  return <StartupAutomaticSetupAction automaticSetup={automaticSetup} />;
}

function StartupAutomaticSetupAction({ automaticSetup }: { readonly automaticSetup: ReturnType<typeof useProjectAutomaticSetup> }) {
  const attempt = automaticSetup.snapshot.attempt;
  switch (attempt?.state) {
    case "awaiting-approval":
      return (
        <ProjectCommandApprovalDialog
          approval={attempt.snapshot?.approval ?? null}
          script={attempt.snapshot?.script ?? null}
          onApprove={async () => {
            await automaticSetup.approveSetup();
            return true;
          }}
          onCancel={() => undefined}
        />
      );
    case "failed":
    case "interrupted":
      return <SetupRecoveryActions automaticSetup={automaticSetup} />;
    default:
      return null;
  }
}

function shouldKeepPreparingShell(
  thread: WorkspaceThread,
  state: ChatViewState,
  startup: ReturnType<typeof useThreadStartup>,
  startupResolving: boolean,
  pendingStartup: PendingStartup | undefined,
  startupDismissed: boolean,
): boolean {
  if (thread.clientPreparing || thread.clientError) return true;
  if (hasConversationHold(state)) return false;
  // A cancelled startup leaves an ordinary empty thread behind: keep the record
  // visible with its actions until the user dismisses it or starts a new turn.
  if (startup?.state === "cancelled") return !startupDismissed && !state.isAgentRunning;
  if (startup !== undefined) return !state.targetPaintable || startup.state !== "completed";
  return pendingStartup !== undefined && startupResolving;
}

function ChatMessageStage({ state, interactions, automaticSetup, startupTrail, selectedTextCommentEditor, selectedTextCommentSourceNavigation, onSubagentSelect, onOpenSubagents }: Pick<ChatViewSurfaceProps, "state" | "interactions" | "selectedTextCommentEditor" | "selectedTextCommentSourceNavigation" | "onSubagentSelect" | "onOpenSubagents"> & { readonly automaticSetup: ReturnType<typeof useProjectAutomaticSetup>; readonly startupTrail: ReactNode }) {
  const thread = state.activeThread!;
  // An empty leading row still takes its 16px padding, which would push the transcript below the preparing surface.
  const automaticSetupTranscriptBlock = thread.mode === "worktree" && thread.worktree_managed === true && automaticSetup.snapshot.gate === "blocked"
    ? <ProjectAutomaticSetupCard snapshot={automaticSetup.snapshot} busy={automaticSetup.busy} error={automaticSetup.error} onContinue={automaticSetup.continueWithoutSetup} onRetry={automaticSetup.retrySetup} onApprove={automaticSetup.approveSetup} />
    : undefined;
  const messageListProps = {
    contentPaddingRight: state.overviewPaddingRight,
    onBranch: interactions.onBranch,
    onSelectedTextComment: interactions.onSelectedTextComment,
    onDeleteSelectedTextComment: interactions.onDeleteSelectedTextComment,
    onSelectedTextCommentEditorChange: interactions.onSelectedTextCommentEditorChange,
    selectedTextCommentEditor,
    selectedTextCommentSourceNavigation,
    onSelectedTextCommentSourceOpened: interactions.onSelectedTextCommentSourceOpened,
    onOpenSelectedTextCommentEditor: interactions.onOpenSelectedTextCommentEditor,
    onSelectedTextCommentSourceUnavailable: interactions.onSelectedTextCommentSourceUnavailable,
    onSelectedTextCommentEditorSourceUnavailable: interactions.onSelectedTextCommentEditorSourceUnavailable,
    selectedTextCommentEditorScope: {
      workspaceId: state.activeWorkspaceId ?? undefined,
      providerId: thread.provider,
    },
    onSubagentSelect,
    onOpenSubagents,
  };
  return (
    <div data-testid="chat-message-stage" className="animate-fade-up-in flex-1 min-h-0">
      <ConversationStageContent stage={getConversationStage(state)} state={state} thread={thread} leadingContent={automaticSetupTranscriptBlock} afterFirstUserContent={startupTrail} messageListProps={messageListProps} />
    </div>
  );
}

/** Renders the composer and plan question wizard for an active thread. */
function ActiveThreadComposer({ state, interactions, pendingSelectedTextComment, pendingSelectedTextCommentDeletion, pendingSelectedTextCommentEditor, unavailableSelectedTextCommentIds, setupBlocked }: Pick<ChatViewSurfaceProps, "state" | "interactions" | "pendingSelectedTextComment" | "pendingSelectedTextCommentDeletion" | "pendingSelectedTextCommentEditor" | "unavailableSelectedTextCommentIds"> & { readonly setupBlocked: boolean }) {
  const thread = state.activeThread!;
  return (
    <div data-testid="chat-composer-stage" className="relative flex-shrink-0" style={{ paddingRight: state.overviewPaddingRight }}>
      <PlanQuestionWizard threadId={thread.id} />
      <Composer threadId={thread.id} workspaceId={state.activeWorkspaceId ?? undefined} branchFromMessageId={state.branchFromMessageId} branchFromMessageContent={state.branchFromMessageContent} selectedTextComment={pendingSelectedTextComment ?? undefined} onSelectedTextCommentConsumed={interactions.onSelectedTextCommentConsumed} selectedTextCommentDeletion={pendingSelectedTextCommentDeletion ?? undefined} onSelectedTextCommentDeletionConsumed={interactions.onSelectedTextCommentDeletionConsumed} selectedTextCommentEditorUpdate={pendingSelectedTextCommentEditor} onSelectedTextCommentEditorUpdateConsumed={interactions.onSelectedTextCommentEditorChangeConsumed} onOpenSelectedTextCommentSource={interactions.onOpenSelectedTextCommentSource} unavailableSelectedTextCommentIds={unavailableSelectedTextCommentIds} onBranchModeExit={interactions.onExitForkMode} setupBlocked={setupBlocked} />
    </div>
  );
}

/** Shows the selected conversation's non-provider hydration failure. */
function ConversationErrorState({ error }: { error: string }) {
  return <div data-testid="conversation-error" role="alert" className="flex h-full items-center justify-center px-4"><div className="max-w-md space-y-1 text-center"><p className="font-medium text-ink">Could not load conversation</p><p className="text-sm text-muted">{error}</p></div></div>;
}

/** Keeps a cold switch target visible without rendering stale transcript content. */
function ConversationTransitionState({ threadId, threadTitle }: { threadId: string; threadTitle: string }) {
  return <div data-testid="conversation-transition-shell" data-thread-id={threadId} role="status" aria-label={`Loading ${threadTitle}`} className="flex h-full items-center justify-center px-4"><div className="flex items-center gap-2 text-sm text-muted"><Spinner size={16} /><span>{threadTitle}</span></div></div>;
}

/** Renders the fully active conversation surface. */
function ActiveThreadSurface(props: ChatViewSurfaceProps & { readonly startup: ReturnType<typeof useThreadStartup> }) {
  const {
    state,
    interactions,
    recovery,
    editingThreadId,
    onEditingThreadIdChange,
    pendingSelectedTextComment,
    pendingSelectedTextCommentDeletion,
    pendingSelectedTextCommentEditor,
    selectedTextCommentEditor,
    selectedTextCommentSourceNavigation,
    unavailableSelectedTextCommentIds,
    onSubagentSelect,
    onOpenSubagents,
    dismissedError,
    startup,
  } = props;
  const thread = state.activeThread!;
  const automaticSetup = useProjectAutomaticSetup(
    thread.id,
    thread.mode === "worktree" && thread.worktree_managed === true,
  );
  const conversationErrorBanner = state.messageCount > 0 || state.isAgentRunning ? conversationErrorLabel(state) : null;
  const showCliError = isVisibleCliError(state.sessionError, dismissedError);
  return (
    // The docked card's reserve takes the right gutter's room, so rows and the composer use 24px
    // gutters while docked. That keeps the composer at 520 or wider down to OVERVIEW_DOCK_MIN_CANVAS.
    <div ref={state.chatPaneRef} className={cn("relative flex h-full flex-col bg-background", state.overviewPaddingRight && "[--chat-gutter:--spacing(6)]")} data-testid="chat-view">
      <OverviewLayer>
        <ThreadHeader state={state} rename={{ editingThreadId, onEditingThreadIdChange, onSaveTitle: interactions.onSaveTitle }} />
        <ActiveThreadBanners state={state} recovery={recovery} />
        {conversationErrorBanner ? <div className="mx-3 mb-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"><p data-testid="conversation-error-banner" role="alert" className="text-sm text-destructive">{conversationErrorBanner}: {state.sessionError}</p></div> : null}
        <HandoffFallbackNotice threadId={thread.id} />
        <SavingDelayedDialog open={state.savingStatus?.mode === "saving-delayed"} onStopSafely={interactions.onStopSafely} onContinueWithoutSaving={interactions.onContinueWithoutSaving} />
        <TurnSavingNotice lostProgress={state.lostProgress} />
        <ChatMessageStage state={state} interactions={interactions} automaticSetup={automaticSetup} startupTrail={startup ? <ThreadStartupTrail thread={thread} startup={startup} pendingStartup={undefined} /> : undefined} selectedTextCommentEditor={selectedTextCommentEditor} selectedTextCommentSourceNavigation={selectedTextCommentSourceNavigation} onSubagentSelect={onSubagentSelect} onOpenSubagents={onOpenSubagents} />
        {showCliError && <CliErrorNotice error={state.sessionError!} onDismiss={interactions.onDismissCliError} onOpenSettings={interactions.onOpenSettings} />}
        <ActiveThreadComposer state={state} interactions={interactions} pendingSelectedTextComment={pendingSelectedTextComment} pendingSelectedTextCommentDeletion={pendingSelectedTextCommentDeletion} pendingSelectedTextCommentEditor={pendingSelectedTextCommentEditor} unavailableSelectedTextCommentIds={unavailableSelectedTextCommentIds} setupBlocked={automaticSetup.snapshot.gate === "blocked"} />
      </OverviewLayer>
    </div>
  );
}

/** Selects the visual chat shell for the current workspace selection. */
export function ChatViewSurface(props: ChatViewSurfaceProps) {
  const { state } = props;
  const pendingStartup = useWorkspaceStore((s) =>
    state.activeThread ? s.pendingStartupByThreadId[state.activeThread.id] : undefined);
  const startupLookup = useThreadStartupLookup({
    startupId: pendingStartup?.startupId,
    threadId: state.activeThread?.id,
    workspaceId: state.activeThread?.workspace_id,
    enabled: Boolean(state.activeThread),
  });
  const startupDismissed = useThreadStartupStore((s) =>
    startupLookup.startup ? s.dismissedStartupIds.has(startupLookup.startup.startupId) : false);
  if (!state.activeThreadId) return <NewThreadStartColumn projectName={state.activeWorkspaceName || undefined} workspaceId={state.activeWorkspaceId ?? undefined} draftId={state.activeDraftId} />;
  if (!state.activeThread) return <MissingThreadSurface />;
  if (shouldKeepPreparingShell(state.activeThread, state, startupLookup.startup, startupLookup.resolving, pendingStartup, startupDismissed)) return <PreparingThreadSurface thread={state.activeThread} state={state} startup={startupLookup.startup} pendingStartup={pendingStartup} />;
  // Keeping a cancelled startup's thread dismisses its record, so the trail leaves the transcript too.
  return <ActiveThreadSurface {...props} startup={startupDismissed ? undefined : startupLookup.startup} />;
}
