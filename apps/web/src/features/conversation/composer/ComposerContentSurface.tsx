import { useRef, type ComponentProps, type DragEventHandler, type MouseEvent, type ReactNode, type RefObject } from "react";
import { ArrowUp, X } from "lucide-react";
import { AttachmentPreview } from "@/components/chat/AttachmentPreview";
import { ComposerAddMenu } from "@/components/chat/ComposerAddMenu";
import { ComposerBranchBar } from "@/components/chat/ComposerBranchBar";
import { ComposerQueueList } from "@/components/chat/ComposerQueueList";
import { FileTagPopup, type useFileTagPopup } from "@/components/chat/FileTagPopup";
import { PlanCommentsComposerChip } from "./PlanCommentsComposerChip";
import { usePlanCommentChip } from "./usePlanCommentChip";
import { removePlanCommentsFromSend } from "@/components/panels/plan/plan-comment-actions";
import { BrowserNotesTile } from "@/features/preview/notes/BrowserNotesTile";
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
import { getCatalogEntry } from "@mcode/contracts/providers/catalog";
import { getModelContextWindow } from "@mcode/shared/model-context";
import type { ContextWindowMode } from "@mcode/contracts/models/settings";
import type { MessageMention } from "@mcode/contracts/models/mention";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";
import type { SelectedTextComment } from "@mcode/contracts/models/selected-text-comment";
import type { Thread } from "@/transport";
import type { SelectedTextCommentEditorDraft } from "@/stores/composerDraftStore";
import { cn } from "@/lib/utils";
import { ComposerAttachedCapabilities } from "./controls/ComposerAttachedCapabilities";
import { ComposerContextLabel } from "./capsule/ComposerContextLabel";
import { ComposerCapsuleSplit } from "./capsule/ComposerCapsuleSplit";
import { ComposerModes, type ComposerModeView } from "./capsule/ComposerModes";
import { useCapsuleRows } from "./capsule/capsule-layout";
import type { ComposerMode } from "./execution/composer-mode";
import { NewThreadTargetRail } from "./execution/NewThreadTargetRail";
import { ComposerTray, composerTrayClass } from "./ComposerTray";
import { clearVisibleBrowserNotes } from "./draft/draft-browser-notes";
import { useDraftWriteFailureStore } from "@/lib/composer-draft-storage";
import { ApprovalAnnouncer, ApprovalDock, useDelegatedThreadTitles, useDockApprovals } from "@/features/conversation/approvals/ApprovalDock";
import { QuestionDock } from "@/features/conversation/approvals/QuestionDock";
import { DiffCommentsComposerAttachment, type ComposerCodeComment } from "./DiffCommentsComposerAttachment";
import { SelectedTextCommentsComposerAttachment } from "./SelectedTextCommentsComposerAttachment";

type FileAutocomplete = ReturnType<typeof useFileAutocomplete>;
type FilePopup = ReturnType<typeof useFileTagPopup>;
type SlashCommand = ReturnType<typeof useSlashCommand>;
type ComposerEditorProps = ComponentProps<typeof ComposerEditor>;
type ComposerAttachedCapabilitiesProps = ComponentProps<typeof ComposerAttachedCapabilities>;
type ComposerCapsuleSplitProps = ComponentProps<typeof ComposerCapsuleSplit>;

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
    readonly needsWorkspace: boolean;
    readonly editingFromQueue: {
      readonly originalIndex: number;
    } | null;
    readonly composerMode: ComposerMode;
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
    readonly annotationScopeId?: string;
    readonly codeComments: readonly ComposerCodeComment[];
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
    readonly selection: ComposerCapsuleSplitProps["selection"];
    readonly defaults: ComposerCapsuleSplitProps["defaults"];
    readonly agentControls: {
      readonly reasoningLevels: ComposerCapsuleSplitProps["reasoningLevels"];
      readonly capabilities: ComposerAttachedCapabilitiesProps["capabilities"];
      readonly attachedCapabilityIds: ComponentProps<typeof ComposerAddMenu>["attachedCapabilityIds"];
      readonly lockedCapabilityIds: ComponentProps<typeof ComposerAddMenu>["lockedCapabilityIds"];
      readonly permissionLocked: ComposerCapsuleSplitProps["permissionLocked"];
      readonly approvalReviewSupported: ComposerCapsuleSplitProps["approvalReviewSupported"];
    };
    readonly activeGoal: ComposerAttachedCapabilitiesProps["activeGoal"];
    readonly isProviderLocked: boolean;
    readonly contextWindow: ContextWindowMode | null;
    readonly settingsDefaultContextWindow: ContextWindowMode | undefined;
    readonly modelId: ComposerCapsuleSplitProps["selection"]["modelId"];
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
    readonly onSelectionChange: ComposerCapsuleSplitProps["onSelectionChange"];
    readonly onSelectionTouched: ComposerCapsuleSplitProps["onSelectionTouched"];
    readonly onDetachPlan: () => void;
    readonly onDetachGoal: () => void;
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
  const tiles = model.attachments.length > 0
    ? <AttachmentPreview attachments={model.attachments} onRemove={actions.onRemoveAttachment} />
    : null;
  // The open slash menu covers the tray, so the hidden controls must not take focus or clicks.
  const covered = model.slashCommand.isOpen;
  if (!model.threadId || model.branchFromMessageId || model.isNewThread) {
    // A draft with no started thread has no queue or tasks, so its tray holds only the tiles.
    return tiles && <div data-testid="composer-tray" inert={covered} className={composerTrayClass(covered)}>{tiles}</div>;
  }
  // Nothing may reach agent.send while the thread is starting, queued messages included.
  const paused = model.planPending || model.startingThread;
  return (
    <ComposerTray
      threadId={model.threadId}
      running={model.isAgentRunning}
      covered={covered}
      tiles={tiles}
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
      onModeChange={actions.onComposerModeChange}
      covered={model.slashCommand.isOpen}
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

/** Editor placeholder copy for the composer's current state; earlier states take precedence. */
export function getEditorPlaceholder(
  model: Pick<
    ComposerContentSurfaceProps["model"],
    | "startingThread"
    | "isStaleWorktree"
    | "goalPending"
    | "branchFromMessageId"
    | "editingFromQueue"
    | "isAgentRunning"
    | "activeThread"
    | "effectiveProviderId"
  >,
) {
  if (model.startingThread) return "Do anything";
  if (model.isStaleWorktree) return "Worktree directory no longer exists. This thread is read-only.";
  if (model.goalPending) return "Describe the goal...";
  if (model.branchFromMessageId) return "What should the branch work on?";
  if (model.editingFromQueue) return "Edit the queued message - send to save.";
  if (model.isAgentRunning) return "Queue a follow-up";
  // A send in this state revises the plan; the server classifies it, so the copy is what tells the user.
  if (model.activeThread?.plan_phase === "ready") return `Tell ${getCatalogEntry(model.effectiveProviderId).name} what to change`;
  return "Do anything";
}

function ComposerDraftCell({
  model,
  actions,
  onDraftChange,
}: Pick<ComposerContentSurfaceProps, "model" | "actions"> & { readonly onDraftChange: () => void }) {
  const disabled = model.startingThread || model.planPending || model.isStaleWorktree || Boolean(model.providerReason);

  return (
    <div
      className={cn(
        "relative min-w-0 [grid-area:E]",
        // One row: one 24px line, clipped so an overflow can be measured. Two rows: full width, scrolling past 240px.
        "max-h-9 overflow-hidden px-2 py-1.5",
        "group-data-[rows=two]/capsule:max-h-60 group-data-[rows=two]/capsule:overflow-y-auto",
        "group-data-[rows=two]/capsule:px-2.5 group-data-[rows=two]/capsule:pt-1.5 group-data-[rows=two]/capsule:pb-0.5",
        model.startingThread && "opacity-50",
      )}
      ref={model.editorContainerRef}
      onPaste={actions.onPaste}
    >
      <ComposerEditor
        capsule
        onChange={(text, mentions) => {
          actions.onEditorChange(text, mentions);
          onDraftChange();
        }}
        onSubmit={actions.onSubmit}
        onMentionTrigger={model.fileAutocomplete.handleInputChange}
        onMentionDismiss={model.fileAutocomplete.dismiss}
        isMentionPopupOpen={model.fileAutocomplete.isOpen}
        onSlashTrigger={model.slashCommand.onEditorTrigger}
        onSlashDismiss={model.slashCommand.onTriggerLost}
        onInlineSlashCommand={actions.onInlineSlashCommand}
        editorRef={model.editorRef}
        disabled={disabled}
        isPopupOpen={model.fileAutocomplete.isOpen || model.slashCommand.isOpen}
        onPopupKeyDown={actions.onPopupKeyDown}
        placeholder={getEditorPlaceholder(model)}
        ariaLabel="Message Mcode"
      />
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
        query={model.slashCommand.query}
        docked
        onSelect={actions.onSlashSelect}
        onHighlight={model.slashCommand.onHighlight}
        onDismiss={model.slashCommand.onBlur}
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
  const planComments = usePlanCommentChip(model.threadId);
  if (!model.annotationScopeId) return null;
  return (
    <>
      <PlanCommentsComposerChip
        comments={planComments}
        onRemove={() => model.threadId && void removePlanCommentsFromSend(model.threadId, planComments)}
      />
      {model.workspaceId ? (
        <BrowserNotesTile
          scopeId={model.annotationScopeId}
          workspaceId={model.workspaceId}
          threadId={model.threadId}
          onRemoveAll={() => {
            actions.onMarkRestoredPreviewAnnotationsCleared();
            clearVisibleBrowserNotes(model.annotationScopeId!);
          }}
        />
      ) : null}
      {model.workspaceId && model.codeComments.length > 0 ? (
        <DiffCommentsComposerAttachment
          comments={model.codeComments}
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
      {model.isDragOver && (
        <div data-drop-overlay className="absolute inset-0 z-(--layer-sticky) flex items-center justify-center rounded-composer bg-primary/10 backdrop-blur-sm">
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

/**
 * Leaves focus in the editor when a composer action is pressed with the pointer. Stop does not end the
 * conversation: the user often types the next instruction straight away, and a focused Stop button turns
 * disabled while the turn stops, which drops focus and every key typed after it.
 */
function keepEditorFocus(event: MouseEvent): void {
  event.preventDefault();
}

function getTrackerContextWindow(
  modelId: ComposerCapsuleSplitProps["selection"]["modelId"],
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

function ComposerContextUsage({
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
    <ComposerContextLabel
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
      size="icon-compact"
      // Empty Send recedes to a selected circle so the amber fill only appears once there is something to send.
      className={cn("ml-0.5", visualState === "empty" && "cursor-default bg-selected text-muted disabled:opacity-100")}
      onMouseDown={keepEditorFocus}
      onClick={onClick}
      disabled={disabled}
      aria-label={SEND_BUTTON_COPY[copy]}
    >
      {visualState === "stopping" ? (
        <Spinner size={16} className="text-current" />
      ) : visualState === "stop" || visualState === "starting" ? (
        <div className="size-3 rounded-[2px] bg-current" />
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

function composerModes(
  model: ComposerContentSurfaceProps["model"],
  actions: ComposerContentSurfaceProps["actions"],
): ComposerModeView[] {
  const labelOf = (id: ComposerModeView["id"]) =>
    model.agentControls.capabilities.find((capability) => capability.id === id)?.label;
  const modes: ComposerModeView[] = [];
  const planLabel = model.selection.interactionMode === "plan" ? labelOf("plan") : undefined;
  if (planLabel) modes.push({ id: "plan", label: planLabel, onRemove: actions.onDetachPlan });
  const goalLabel = model.goalPending ? labelOf("goal") : undefined;
  if (goalLabel) modes.push({ id: "goal", label: goalLabel, onRemove: actions.onDetachGoal });
  return modes;
}

interface ComposerCapsuleRowProps extends Pick<ComposerContentSurfaceProps, "model" | "actions"> {
  readonly rowRef: RefObject<HTMLDivElement | null>;
  readonly leftRef: RefObject<HTMLDivElement | null>;
  readonly rightRef: RefObject<HTMLDivElement | null>;
  readonly onDraftChange: () => void;
  /** The composer is hidden behind a dock: only the draft stays mounted, so its menus and popovers cannot float. */
  readonly hidden: boolean;
}

function ComposerCapsuleLeft({ model, actions, leftRef }: Pick<ComposerCapsuleRowProps, "model" | "actions" | "leftRef">) {
  const disabled = model.planPending || model.isStaleWorktree || Boolean(model.providerReason);
  return (
    <div ref={leftRef} className="flex min-w-0 items-center gap-1 [grid-area:L]">
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
      <ComposerModes
        modes={composerModes(model, actions)}
        add={(
          <ComposerAddMenu
            disabled={disabled}
            onAttachFiles={actions.onAttachPick}
            capabilities={model.agentControls.capabilities}
            attachedCapabilityIds={model.agentControls.attachedCapabilityIds}
            lockedCapabilityIds={model.agentControls.lockedCapabilityIds}
            onAttachCapability={actions.onAttachCapability}
            getComposerRect={() => model.composerContainerRef.current?.getBoundingClientRect() ?? null}
          />
        )}
      />
      <ComposerAttachedCapabilities
        threadId={model.threadId}
        isNewThread={model.isNewThread}
        selection={model.selection}
        capabilities={model.agentControls.capabilities}
        activeGoal={model.activeGoal}
        onDetachOrchestration={actions.onDetachOrchestration}
      />
      {model.providerNoticeTrigger}
    </div>
  );
}

function ComposerCapsuleRight({ model, actions, rightRef }: Pick<ComposerCapsuleRowProps, "model" | "actions" | "rightRef">) {
  return (
    <div ref={rightRef} className="flex min-w-0 items-center justify-end gap-1 [grid-area:R]">
      <ComposerStartingSpinner startingThread={model.startingThread} />
      <ComposerCapsuleSplit
        anchorRef={model.composerContainerRef}
        threadId={model.threadId}
        branchFromMessageId={model.branchFromMessageId}
        selection={model.selection}
        defaults={model.defaults}
        reasoningLevels={model.agentControls.reasoningLevels}
        permissionLocked={model.agentControls.permissionLocked}
        approvalReviewSupported={model.agentControls.approvalReviewSupported}
        isProviderLocked={model.isProviderLocked}
        onSelectionChange={actions.onSelectionChange}
        onSelectionTouched={actions.onSelectionTouched}
      >
        <ComposerContextUsage model={model} />
        <ComposerSendButton
          model={model}
          actions={actions}
          needsWorkspace={model.needsWorkspace}
        />
      </ComposerCapsuleSplit>
    </div>
  );
}

/**
 * The capsule's grid. One row is `+` and the modes, the draft, then the right group; once the draft wraps it takes
 * the full width on top and the controls drop to a row below.
 */
function ComposerCapsuleRow({ model, actions, rowRef, leftRef, rightRef, onDraftChange, hidden }: ComposerCapsuleRowProps) {
  return (
    <div
      ref={rowRef}
      data-capsule-row
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1 py-[5px] pr-[5px] pl-1.5 [grid-template-areas:'L_E_R']",
        "group-data-[rows=two]/capsule:gap-y-0.5 group-data-[rows=two]/capsule:pt-1.5",
        "group-data-[rows=two]/capsule:[grid-template-areas:'E_E_E'_'L_._R']",
      )}
    >
      {!hidden && <ComposerCapsuleLeft model={model} actions={actions} leftRef={leftRef} />}
      <ComposerDraftCell model={model} actions={actions} onDraftChange={onDraftChange} />
      {!hidden && <ComposerCapsuleRight model={model} actions={actions} rightRef={rightRef} />}
    </div>
  );
}

function ComposerInputSurface({
  model,
  actions,
  hidden,
}: ComposerContentSurfaceProps & { readonly hidden: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const { rows, remeasure } = useCapsuleRows({ capsule: rowRef, left: leftRef, right: rightRef, draft: model.editorContainerRef }, { hidden });
  return (
    <div
      ref={model.composerContainerRef}
      data-testid="composer-surface"
      data-rows={rows}
      className={cn(
        "group/capsule @container/capsule relative z-(--layer-sticky) border border-border bg-selected focus-within:border-control-border",
        rows === "one" ? "rounded-full" : "rounded-[22px]",
        // Whatever shows above the row inside the card (a bar, a notice, comment chips) keeps it from a full round.
        "has-[>:not(.sr-only,[data-drop-overlay])~[data-capsule-row]]:rounded-[22px]",
        // Hidden, not unmounted, while approvals wait, so the draft and editor state survive.
        // Its popups and control-bar menus do unmount: they anchor to the hidden box and would float or keep focus.
        hidden && "hidden",
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
      <ComposerAttachmentSurface model={model} actions={actions} />
      <ComposerCapsuleRow model={model} actions={actions} rowRef={rowRef} leftRef={leftRef} rightRef={rightRef} onDraftChange={remeasure} hidden={hidden} />
      {!hidden && <ComposerEditorPopups model={model} actions={actions} />}
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
    <p role="status" className="px-1 pt-1 text-xs text-muted">
      Draft not saved · {DRAFT_WRITE_FAILURE_DETAIL[failure]}
    </p>
  );
}

/** Which dock takes the composer's place: pending approvals first, then the plan questions. */
export function getComposerDock(args: {
  readonly approvalCount: number;
  readonly planPending: boolean;
  readonly threadId: string | undefined;
}): "approvals" | "questions" | null {
  if (args.approvalCount > 0) return "approvals";
  return args.planPending && args.threadId ? "questions" : null;
}

export function ComposerContentSurface(props: ComposerContentSurfaceProps) {
  const { model, actions } = props;
  const delegatedThreads = useDelegatedThreadTitles(model.threadId);
  const approvals = useDockApprovals(model.threadId, delegatedThreads);
  const dock = getComposerDock({ approvalCount: approvals.length, planPending: model.planPending, threadId: model.threadId });
  const docked = dock !== null;
  return (
    <>
      <ComposerNewThreadSurface {...props} />
      <ComposerTraySurface {...props} />
      <ApprovalAnnouncer requests={approvals} />
      {dock === "approvals" && (
        <ApprovalDock
          key={model.threadId}
          requests={approvals}
          delegatedThreads={delegatedThreads}
          composerContainerRef={model.composerContainerRef}
          isAgentRunning={model.isAgentRunning}
          isStopPending={model.isStopPending}
          onStop={actions.onStop}
          onFocusComposer={actions.onFocusComposer}
        />
      )}
      {dock === "questions" && model.threadId && (
        <QuestionDock
          key={model.threadId}
          threadId={model.threadId}
          providerId={model.effectiveProviderId}
          composerContainerRef={model.composerContainerRef}
          isAgentRunning={model.isAgentRunning}
          isStopPending={model.isStopPending}
          onStop={actions.onStop}
          onFocusComposer={actions.onFocusComposer}
        />
      )}
      <ComposerInputSurface {...props} hidden={docked} />
      <DraftWriteFailureNotice />
    </>
  );
}
