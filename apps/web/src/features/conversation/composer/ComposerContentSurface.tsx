import type { ComponentProps, DragEventHandler, ReactNode, RefObject } from "react";
import { ArrowUp, X } from "lucide-react";
import type { OverviewPresentation } from "@/stores/overviewStore";
import { AttachmentPreview } from "@/components/chat/AttachmentPreview";
import { ComposerAddMenu } from "@/components/chat/ComposerAddMenu";
import { ComposerBranchBar } from "@/components/chat/ComposerBranchBar";
import { ComposerQueueList } from "@/components/chat/ComposerQueueList";
import { ContextTracker } from "@/components/chat/ContextTracker";
import { FileTagPopup, type useFileTagPopup } from "@/components/chat/FileTagPopup";
import { PreviewAnnotationBundleChip } from "@/components/chat/PreviewAnnotationBundleChip";
import { providerUnavailableMessage, type ProviderUnavailableReason } from "@/components/chat/provider-unavailable";
import { Notice } from "@/components/ui/notice";
import { type useSlashCommand } from "@/components/chat/useSlashCommand";
import { SlashCommandTray } from "@/components/chat/SlashCommandTray";
import { SpellcheckContextMenu } from "@/components/chat/SpellcheckContextMenu";
import { useFileAutocomplete } from "@/components/chat/useFileAutocomplete";
import { ComposerEditor } from "@/components/chat/lexical";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePreviewAnnotationStore } from "@/features/preview/state/previewAnnotationStore";
import type { DraftDiffComment } from "@mcode/contracts";
import { getModelContextWindow } from "@mcode/shared/model-context";
import type {
  ContextWindowMode,
  MessageMention,
  ProviderId,
  SelectedTextComment,
} from "@mcode/contracts";
import type { Thread } from "@/transport";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { cn } from "@/lib/utils";
import { ComposerAccessControls } from "./controls/ComposerAccessControls";
import { ComposerAttachedCapabilities } from "./controls/ComposerAttachedCapabilities";
import { ComposerModelControl } from "./controls/ComposerModelControl";
import type { ComposerMode } from "./execution/composer-mode";
import { NewThreadTargetRail } from "./execution/NewThreadTargetRail";
import { ComposerTray } from "./ComposerTray";
import { useDraftWriteFailureStore } from "@/lib/composer-draft-storage";
import { ApprovalAnnouncer, ApprovalDock, useDockApprovals } from "@/features/conversation/approvals/ApprovalDock";
import { DiffCommentsComposerAttachment } from "./DiffCommentsComposerAttachment";
import { SelectedTextCommentsComposerAttachment } from "./SelectedTextCommentsComposerAttachment";

type FileAutocomplete = ReturnType<typeof useFileAutocomplete>;
type FilePopup = ReturnType<typeof useFileTagPopup>;
type SlashCommand = ReturnType<typeof useSlashCommand>;
type ComposerEditorProps = ComponentProps<typeof ComposerEditor>;
type ComposerAccessControlsProps = ComponentProps<typeof ComposerAccessControls>;
type ComposerAttachedCapabilitiesProps = ComponentProps<typeof ComposerAttachedCapabilities>;
type ComposerModelControlProps = ComponentProps<typeof ComposerModelControl>;

interface ComposerContentSurfaceProps {
  readonly model: {
    readonly threadId?: string;
    readonly workspaceId?: string;
    readonly isNewThread: boolean;
    readonly branchFromMessageId?: string;
    readonly branchFromMessageContent?: string;
    readonly activeThread?: Thread;
    readonly isAgentRunning: boolean;
    readonly isStopPending: boolean;
    readonly provider?: string;
    readonly planPending: boolean;
    readonly queuedSend: boolean;
    readonly needsWorkspace: boolean;
    readonly editingFromQueue: {
      readonly originalIndex: number;
    } | null;
    readonly composerMode: ComposerMode;
    readonly overviewPresentation: OverviewPresentation;
    readonly isDragOver: boolean;
    /** A new thread or fork has no branch to send yet, so Send waits. */
    readonly targetPending: boolean;
    readonly effectiveProviderId: ProviderId;
    readonly providerReason: ProviderUnavailableReason | null;
    readonly goalPending: boolean;
    readonly isStaleWorktree: boolean;
    readonly fileAutocomplete: FileAutocomplete;
    readonly filePopup: FilePopup;
    readonly filePopupAnchorRect: DOMRect | null;
    readonly slashCommand: SlashCommand;
    readonly workspacePath?: string;
    readonly attachmentBundle?: ComponentProps<typeof PreviewAnnotationBundleChip>["bundle"];
    readonly annotationScopeId?: string;
    readonly diffComments: readonly DraftDiffComment[];
    readonly attachments: ComponentProps<typeof AttachmentPreview>["attachments"];
    readonly selectedTextComments: readonly SelectedTextComment[];
    readonly selectedTextCommentEditor?: SelectedTextCommentEditorDraft;
    readonly unavailableSelectedTextCommentIds: readonly string[];
    readonly startingThread: boolean;
    readonly hasContent: boolean;
    readonly attachmentInputRef: RefObject<HTMLInputElement | null>;
    readonly attachmentInputAccept: string;
    readonly composerContainerRef: RefObject<HTMLDivElement | null>;
    readonly editorContainerRef: RefObject<HTMLDivElement | null>;
    readonly editorRef: ComposerEditorProps["editorRef"];
    readonly selection: ComposerModelControlProps["selection"];
    readonly defaults: ComposerModelControlProps["defaults"];
    readonly agentControls: {
      readonly reasoningLevels: ComposerModelControlProps["reasoningLevels"];
      readonly capabilities: ComposerAttachedCapabilitiesProps["capabilities"];
      readonly attachedCapabilityIds: ComponentProps<typeof ComposerAddMenu>["attachedCapabilityIds"];
      readonly permissionLocked: ComposerAccessControlsProps["permissionLocked"];
      readonly approvalReviewSupported: ComposerAccessControlsProps["approvalReviewSupported"];
    };
    readonly activeGoal: ComposerAttachedCapabilitiesProps["activeGoal"];
    readonly isModelFullyLocked: boolean;
    readonly isProviderLocked: boolean;
    readonly contextWindow: ContextWindowMode | null;
    readonly settingsDefaultContextWindow: ContextWindowMode | undefined;
    readonly modelId: ComposerModelControlProps["selection"]["modelId"];
    readonly contextEntry?: {
      readonly lastTokensIn?: number;
      readonly contextWindow?: number;
      readonly totalProcessedTokens?: number;
    };
    readonly hasLowQuota: boolean;
    readonly providerNoticeTrigger?: ReactNode;
  };
  readonly actions: {
    readonly onBranchModeExit?: () => void;
    readonly onComposerModeChange: (mode: ComposerMode) => void;
    readonly onLoadIntoComposer: ComponentProps<typeof ComposerQueueList>["onLoadIntoComposer"];
    readonly onSendQueuedMessageNow: NonNullable<ComponentProps<typeof ComposerQueueList>["onSendNow"]>;
    readonly onDragEnter: DragEventHandler<HTMLDivElement>;
    readonly onDragLeave: DragEventHandler<HTMLDivElement>;
    readonly onDragOver: DragEventHandler<HTMLDivElement>;
    readonly onDrop: DragEventHandler<HTMLDivElement>;
    readonly onCancelEdit: () => void;
    readonly onEditorChange: (text: string, mentions: MessageMention[]) => void;
    readonly onSubmit: () => void;
    readonly onPopupKeyDown: (key: string) => boolean;
    readonly onInlineSlashCommand: NonNullable<ComposerEditorProps["onInlineSlashCommand"]>;
    readonly onSlashSelect: ComponentProps<typeof SlashCommandTray>["onSelect"];
    readonly onMentionSelect: ComponentProps<typeof FileTagPopup>["onSelect"];
    readonly onPaste: ComponentProps<"div">["onPaste"];
    readonly onMarkRestoredPreviewAnnotationsCleared: () => void;
    readonly onRemoveAttachment: ComponentProps<typeof AttachmentPreview>["onRemove"];
    readonly onAttachmentInputChange: ComponentProps<"input">["onChange"];
    readonly onAttachPick: () => void;
    readonly onAttachCapability: ComponentProps<typeof ComposerAddMenu>["onAttachCapability"];
    readonly onSelectionChange: ComposerModelControlProps["onSelectionChange"];
    readonly onSelectionTouched: ComposerAccessControlsProps["onSelectionTouched"];
    readonly onDetachPlan: ComposerAttachedCapabilitiesProps["onDetachPlan"];
    readonly onDetachGoal: ComposerAttachedCapabilitiesProps["onDetachGoal"];
    readonly onDetachOrchestration: ComposerAttachedCapabilitiesProps["onDetachOrchestration"];
    readonly onStop: () => void;
    /** Cancels the thread's startup; absent once cancellation is requested. */
    readonly onCancelStartup?: () => void;
    readonly onClearSelectedTextComments: () => void;
    readonly onEditSelectedTextComment: (comment: SelectedTextComment) => void;
    readonly onDeleteSelectedTextComment: (comment: SelectedTextComment) => void;
    readonly onFocusComposer: () => void;
    readonly onOpenSelectedTextCommentSource: (comment: SelectedTextComment) => void;
    readonly onSaveSelectedTextComment: (comment: SelectedTextComment) => void;
    readonly onSelectedTextCommentEditorChange: (editor: SelectedTextCommentEditorDraft | undefined) => void;
  };
}

function ComposerTraySurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.threadId || model.branchFromMessageId || model.isNewThread) return null;
  // Nothing may reach agent.send while the thread is starting, queued messages included.
  const paused = model.planPending || model.startingThread;
  return (
    <ComposerTray
      threadId={model.threadId}
      running={model.isAgentRunning}
      queue={(
        <ComposerQueueList
          threadId={model.threadId}
          provider={model.provider}
          isPaused={paused}
          onLoadIntoComposer={actions.onLoadIntoComposer}
          onSendNow={(message) => { if (!paused) void actions.onSendQueuedMessageNow(message); }}
        />
      )}
    />
  );
}

function ComposerNewThreadSurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.isNewThread) return null;

  return (
    <NewThreadTargetRail
      workspaceId={model.workspaceId}
      mode={model.composerMode}
      overviewPresentation={model.overviewPresentation}
      onModeChange={actions.onComposerModeChange}
    />
  );
}

function ComposerProviderUnavailableNotice({
  model,
}: Pick<ComposerContentSurfaceProps, "model">) {
  if (!model.providerReason) return null;

  return (
    <Notice
      tone="warning"
      title="Provider unavailable"
      detail={providerUnavailableMessage(model.effectiveProviderId, model.providerReason)}
      action={{
        label: "Open Settings",
        onClick: () => window.dispatchEvent(new CustomEvent("mcode:open-settings", { detail: { section: "model" } })),
      }}
      data-testid="provider-unavailable-notice"
      className="mb-2"
    />
  );
}

function ComposerQueueEditNotice({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.editingFromQueue) return null;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-primary/20 bg-primary/5 px-3 py-1.5">
      <span className="font-mono text-xs uppercase tracking-[0.18em] text-primary/85">
        Editing
        <span className="ml-1.5 tabular-nums text-primary/55">
          {String(model.editingFromQueue.originalIndex + 1).padStart(2, "0")}
        </span>
        <span className="ml-2 normal-case tracking-normal text-primary/55">
          Send to save - changes return to the same slot.
        </span>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={actions.onCancelEdit}
              aria-label="Discard edits and restore the original queued message"
              className="rounded-sm p-1 text-primary/55 transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <X size={11} />
            </button>
          }
        />
        <TooltipContent>Discard changes (restores the original message at its slot)</TooltipContent>
      </Tooltip>
    </div>
  );
}

function getEditorPlaceholder(model: ComposerContentSurfaceProps["model"]) {
  if (model.startingThread) return "Do anything";
  if (model.isStaleWorktree) return "Worktree directory no longer exists. This thread is read-only.";
  if (model.planPending) return "Answer the planning questions above";
  if (model.goalPending) return "Describe the goal...";
  if (model.branchFromMessageId) return "What should the branch work on?";
  if (model.editingFromQueue) return "Edit the queued message - send to save.";
  if (model.isAgentRunning) return "Queue a follow-up";
  return "Do anything";
}

function ComposerEditorSurface({
  model,
  actions,
  hidden,
}: Pick<ComposerContentSurfaceProps, "model" | "actions"> & { readonly hidden: boolean }) {
  const disabled = model.startingThread || model.planPending || model.isStaleWorktree || Boolean(model.providerReason);

  return (
    <div className={cn("relative px-4 pt-4", model.startingThread && "opacity-50")} ref={model.editorContainerRef} onPaste={actions.onPaste}>
      <ComposerEditor
        onChange={actions.onEditorChange}
        onSubmit={actions.onSubmit}
        onMentionTrigger={model.fileAutocomplete.handleInputChange}
        onMentionDismiss={model.fileAutocomplete.dismiss}
        isMentionPopupOpen={model.fileAutocomplete.isOpen}
        onSlashTrigger={model.slashCommand.onInputChange}
        onSlashDismiss={model.slashCommand.onDismiss}
        isSlashPopupOpen={model.slashCommand.isOpen}
        onInlineSlashCommand={actions.onInlineSlashCommand}
        editorRef={model.editorRef}
        disabled={disabled}
        isPopupOpen={model.fileAutocomplete.isOpen || model.slashCommand.isOpen}
        onPopupKeyDown={actions.onPopupKeyDown}
        placeholder={getEditorPlaceholder(model)}
        ariaLabel="Message Mcode"
      />
      {!hidden && (
        <ComposerEditorPopups model={model} actions={actions} />
      )}
    </div>
  );
}

/** Popups anchored to the editor; positioned against it, so they cannot outlive it being hidden. */
function ComposerEditorPopups({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  return (
    <>
      <FileTagPopup
        items={model.fileAutocomplete.suggestions}
        isOpen={model.fileAutocomplete.isOpen}
        onSelect={actions.onMentionSelect}
        listRef={model.filePopup.listRef}
        selectedIndex={model.filePopup.selectedIndex}
        anchorRect={model.filePopupAnchorRect}
        presentation="composer"
      />
      <SlashCommandTray
        state={model.slashCommand.state}
        selectedIndex={model.slashCommand.selectedIndex}
        anchorRect={model.slashCommand.anchorRect}
        workspacePath={model.workspacePath}
        onSelect={actions.onSlashSelect}
        onDismiss={model.slashCommand.onDismiss}
        onRetry={model.slashCommand.onRetry}
      />
      <SpellcheckContextMenu editorRef={model.editorContainerRef} />
    </>
  );
}

function AnnotationAttachmentRow({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  if (!model.annotationScopeId) return null;
  return (
    <>
      {model.attachmentBundle ? (
        <div className="px-3 pt-2">
          <PreviewAnnotationBundleChip
            bundle={model.attachmentBundle}
            threadId={model.threadId}
            testId="composer-annotation-bundle"
            onRemove={() => {
              actions.onMarkRestoredPreviewAnnotationsCleared();
              usePreviewAnnotationStore.getState().clearThread(model.annotationScopeId!);
            }}
          />
        </div>
      ) : null}
      {model.workspaceId && model.diffComments.length > 0 ? (
        <DiffCommentsComposerAttachment
          comments={model.diffComments}
          scopeId={model.annotationScopeId}
          workspaceId={model.workspaceId}
          threadId={model.threadId}
          onFocusComposer={actions.onFocusComposer}
        />
      ) : null}
    </>
  );
}

function ComposerAttachmentSurface({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  return (
    <>
      <AnnotationAttachmentRow model={model} actions={actions} />
      <AttachmentPreview attachments={model.attachments} onRemove={actions.onRemoveAttachment} />
      {model.isDragOver && (
        <div className="absolute inset-0 z-(--layer-sticky) flex items-center justify-center rounded-composer bg-primary/10 backdrop-blur-sm">
          <span className="text-sm font-medium text-primary">Drop files here</span>
        </div>
      )}
    </>
  );
}

function ComposerStartingSpinner({
  startingThread,
}: Pick<ComposerContentSurfaceProps["model"], "startingThread">) {
  if (!startingThread) return null;

  return (
    <span className="flex size-8 items-center justify-center" data-testid="composer-starting-spinner">
      <Spinner size={20} className="text-muted" />
    </span>
  );
}

function ComposerInlineStopButton({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  // The starting Stop already cancels the dispatched first turn, so a second Stop would be redundant.
  if (model.startingThread || !model.isAgentRunning || !model.hasContent || model.planPending) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            shape="round"
            size="icon-compact"
            onClick={actions.onStop}
            aria-label="Stop agent"
          >
            <div className="size-2.5 rounded-[2px] bg-ink" />
          </Button>
        }
      />
      <TooltipContent>Stop agent</TooltipContent>
    </Tooltip>
  );
}

function getTrackerContextWindow(
  modelId: ComposerModelControlProps["selection"]["modelId"],
  contextWindow: ContextWindowMode | null,
  settingsDefaultContextWindow: ContextWindowMode | undefined,
  contextEntry: ComposerContentSurfaceProps["model"]["contextEntry"],
  activeThread: Thread | undefined,
) {
  const mode = contextWindow ?? settingsDefaultContextWindow ?? "200k";
  return getModelContextWindow(modelId, mode)
    ?? contextEntry?.contextWindow
    ?? activeThread?.context_window
    ?? undefined;
}

function ComposerContextWindowTracker({
  model,
}: Pick<ComposerContentSurfaceProps, "model">) {
  if (!model.threadId) return null;

  const contextWindow = getTrackerContextWindow(
    model.modelId,
    model.contextWindow,
    model.settingsDefaultContextWindow,
    model.contextEntry,
    model.activeThread,
  );

  return (
    <ContextTracker
      tokensIn={model.contextEntry?.lastTokensIn ?? model.activeThread?.last_context_tokens ?? 0}
      contextWindow={contextWindow}
      totalProcessedTokens={model.contextEntry?.totalProcessedTokens}
      hasLowQuota={model.hasLowQuota}
    />
  );
}

export type ComposerSendButtonVisualState = "starting" | "queue" | "stop" | "stopping" | "send" | "empty";
type ComposerSendButtonCopy = "choose-project" | "cancel-startup" | "queue-message" | "stop-agent" | "stopping-agent" | "send-message";

export function getComposerSendButtonVisualState({
  startingThread,
  isAgentRunning,
  isStopPending,
  hasContent,
}: Pick<ComposerContentSurfaceProps["model"], "startingThread" | "isAgentRunning" | "isStopPending" | "hasContent">): ComposerSendButtonVisualState {
  if (startingThread) return "starting";
  if (isStopPending) return "stopping";
  if (isAgentRunning) return hasContent ? "queue" : "stop";
  return hasContent ? "send" : "empty";
}

function getComposerSendButtonCopy({
  needsWorkspace,
  startingThread,
  isAgentRunning,
  isStopPending,
  hasContent,
}: {
  readonly needsWorkspace: boolean;
  readonly startingThread: boolean;
  readonly isAgentRunning: boolean;
  readonly isStopPending: boolean;
  readonly hasContent: boolean;
}): ComposerSendButtonCopy {
  if (needsWorkspace) return "choose-project";
  if (startingThread) return "cancel-startup";
  if (isStopPending) return "stopping-agent";
  if (isAgentRunning) return hasContent ? "queue-message" : "stop-agent";
  return "send-message";
}

export function isComposerSendButtonDisabled({
  needsWorkspace,
  providerReason,
  isStaleWorktree,
  planPending,
  startingThread,
  isAgentRunning,
  isStopPending,
  hasContent,
  canCancelStartup,
  targetPending,
}: {
  readonly needsWorkspace: boolean;
  readonly providerReason: ComposerContentSurfaceProps["model"]["providerReason"];
  readonly isStaleWorktree: boolean;
  readonly planPending: boolean;
  readonly startingThread: boolean;
  readonly isAgentRunning: boolean;
  readonly isStopPending: boolean;
  readonly hasContent: boolean;
  readonly canCancelStartup: boolean;
  readonly targetPending: boolean;
}) {
  // A starting thread never sends, so its button is only Stop for the startup.
  if (startingThread) return !canCancelStartup;
  // With content the button sends, so it waits for a known target branch. Without content it stops a running agent.
  return needsWorkspace || Boolean(providerReason) || isStaleWorktree || planPending
    || isStopPending || (hasContent ? targetPending : !isAgentRunning);
}

/** Button variant per send state. Send is the round primary; Stop is neutral by rule: an ink circle with a background-colour square. */
export const SEND_BUTTON_VARIANT: Record<ComposerSendButtonVisualState, "default" | "ink"> = {
  starting: "ink",
  queue: "default",
  stop: "ink",
  stopping: "ink",
  send: "default",
  empty: "default",
};

const SEND_BUTTON_COPY: Record<ComposerSendButtonCopy, string> = {
  "choose-project": "Choose a project",
  "cancel-startup": "Cancel startup",
  "queue-message": "Queue message",
  "stop-agent": "Stop agent",
  "stopping-agent": "Stopping",
  "send-message": "Send message",
};

function ComposerSendButton({
  model,
  actions,
  needsWorkspace,
}: Pick<ComposerContentSurfaceProps, "model" | "actions"> & { readonly needsWorkspace: boolean }) {
  const visualState = getComposerSendButtonVisualState(model);
  const copy = getComposerSendButtonCopy({ ...model, needsWorkspace });
  const disabled = isComposerSendButtonDisabled({ ...model, needsWorkspace, canCancelStartup: actions.onCancelStartup !== undefined });
  const onClick = model.startingThread
    ? actions.onCancelStartup
    : model.isAgentRunning && !model.hasContent
      ? actions.onStop
      : actions.onSubmit;
  const sendButton = (
    <Button
      type="button"
      variant={SEND_BUTTON_VARIANT[visualState]}
      shape="round"
      size="icon-default"
      // Empty Send recedes to a panel circle so the amber fill only appears once there is something to send.
      className={cn(visualState === "empty" && "bg-panel text-muted")}
      onClick={onClick}
      disabled={disabled}
      aria-label={SEND_BUTTON_COPY[copy]}
    >
      {visualState === "stopping" ? (
        <Spinner size={16} className="text-current" />
      ) : visualState === "stop" || visualState === "starting" ? (
        <div className="size-3.5 rounded-[2px] bg-current" />
      ) : (
        <ArrowUp />
      )}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={disabled ? <span className="inline-flex">{sendButton}</span> : sendButton}
      />
      <TooltipContent>{SEND_BUTTON_COPY[copy]}</TooltipContent>
    </Tooltip>
  );
}

function ComposerControlBar({
  model,
  actions,
}: Pick<ComposerContentSurfaceProps, "model" | "actions">) {
  const disabled = model.planPending || model.isStaleWorktree || Boolean(model.providerReason);

  return (
    <div className="@container flex min-w-0 flex-wrap items-center justify-between gap-2 p-4">
      <input
        ref={model.attachmentInputRef}
        type="file"
        multiple
        disabled={disabled}
        className="hidden"
        accept={model.attachmentInputAccept}
        data-testid="composer-attachment-input"
        onChange={actions.onAttachmentInputChange}
      />
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <ComposerAddMenu
          disabled={disabled}
          onAttachFiles={actions.onAttachPick}
          capabilities={model.agentControls.capabilities}
          attachedCapabilityIds={model.agentControls.attachedCapabilityIds}
          onAttachCapability={actions.onAttachCapability}
          getComposerRect={() => model.composerContainerRef.current?.getBoundingClientRect() ?? null}
        />
        <ComposerAccessControls
          threadId={model.threadId}
          workspaceId={model.workspaceId}
          branchFromMessageId={model.branchFromMessageId}
          selection={model.selection}
          isModelLocked={model.isModelFullyLocked}
          permissionLocked={model.agentControls.permissionLocked}
          approvalReviewSupported={model.agentControls.approvalReviewSupported}
          onSelectionChange={actions.onSelectionChange}
          onSelectionTouched={actions.onSelectionTouched}
        />
        <ComposerAttachedCapabilities
          threadId={model.threadId}
          isNewThread={model.isNewThread}
          selection={model.selection}
          capabilities={model.agentControls.capabilities}
          activeGoal={model.activeGoal}
          goalPending={model.goalPending}
          onDetachPlan={actions.onDetachPlan}
          onDetachGoal={actions.onDetachGoal}
          onDetachOrchestration={actions.onDetachOrchestration}
        />
        {model.providerNoticeTrigger}
      </div>
      <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
        <ComposerStartingSpinner startingThread={model.startingThread} />
        <ComposerInlineStopButton model={model} actions={actions} />
        <ComposerContextWindowTracker model={model} />
        <ComposerModelControl
          threadId={model.threadId}
          branchFromMessageId={model.branchFromMessageId}
          selection={model.selection}
          defaults={model.defaults}
          reasoningLevels={model.agentControls.reasoningLevels}
          isModelLocked={model.isModelFullyLocked}
          isProviderLocked={model.isProviderLocked}
          onSelectionChange={actions.onSelectionChange}
        />
        <ComposerSendButton
          model={model}
          actions={actions}
          needsWorkspace={model.needsWorkspace}
        />
      </div>
    </div>
  );
}

function ComposerInputSurface({
  model,
  actions,
  hidden,
}: ComposerContentSurfaceProps & { readonly hidden: boolean }) {
  return (
    <div
      ref={model.composerContainerRef}
      data-testid="composer-surface"
      className={cn(
        "relative z-(--layer-sticky) rounded-composer border border-border bg-selected",
        // Hidden, not unmounted, while approvals wait, so the draft and editor state survive.
        // Its popups and control-bar menus do unmount: they anchor to the hidden box and would float or keep focus.
        hidden && "hidden",
        model.isNewThread && "-mt-px",
        model.isDragOver && "ring-2 ring-primary",
      )}
      onDragEnter={actions.onDragEnter}
      onDragLeave={actions.onDragLeave}
      onDragOver={actions.onDragOver}
      onDrop={actions.onDrop}
    >
      <ComposerBranchBar
        branchFromMessageId={model.branchFromMessageId}
        branchFromMessageContent={model.branchFromMessageContent}
        onBranchModeExit={actions.onBranchModeExit}
      />
      <SelectedTextCommentsComposerAttachment
        comments={model.selectedTextComments}
        editor={model.selectedTextCommentEditor}
        unavailableSourceCommentIds={model.unavailableSelectedTextCommentIds}
        onRemove={actions.onClearSelectedTextComments}
        onOpenSource={actions.onOpenSelectedTextCommentSource}
        onEdit={actions.onEditSelectedTextComment}
        onDelete={actions.onDeleteSelectedTextComment}
        onFocusComposer={actions.onFocusComposer}
        onSave={actions.onSaveSelectedTextComment}
        onEditorChange={actions.onSelectedTextCommentEditorChange}
      />
      <ComposerProviderUnavailableNotice model={model} />
      <ComposerQueueEditNotice model={model} actions={actions} />
      <ComposerEditorSurface model={model} actions={actions} hidden={hidden} />
      <ComposerAttachmentSurface model={model} actions={actions} />
      {!hidden && <ComposerControlBar model={model} actions={actions} />}
    </div>
  );
}

/** Renders the composer content rail, input surface, and queued-send hint. */
const DRAFT_WRITE_FAILURE_DETAIL = {
  "storage-full": "Storage is full",
  "storage-unavailable": "Storage unavailable",
} as const;

/** Says the draft was not saved; the next successful write clears it. */
function DraftWriteFailureNotice() {
  const failure = useDraftWriteFailureStore((state) => state.failure);
  if (!failure) return null;
  return (
    <p role="status" className="px-1 pt-1 text-xs text-muted-foreground">
      Draft not saved · {DRAFT_WRITE_FAILURE_DETAIL[failure]}
    </p>
  );
}

export function ComposerContentSurface(props: ComposerContentSurfaceProps) {
  const { model, actions } = props;
  const approvals = useDockApprovals(model.threadId);
  const docked = approvals.length > 0;
  return (
    <>
      <ComposerNewThreadSurface {...props} />
      <ComposerTraySurface {...props} />
      <ApprovalAnnouncer requests={approvals} />
      {docked && (
        <ApprovalDock
          key={model.threadId}
          requests={approvals}
          composerContainerRef={model.composerContainerRef}
          isAgentRunning={model.isAgentRunning}
          isStopPending={model.isStopPending}
          onStop={actions.onStop}
          onFocusComposer={actions.onFocusComposer}
        />
      )}
      <ComposerInputSurface {...props} hidden={docked} />
      {props.model.queuedSend && (
        <p className="px-1 pt-1 text-xs text-muted/60">
          queued · sends when handoff lands
        </p>
      )}
      <DraftWriteFailureNotice />
    </>
  );
}
