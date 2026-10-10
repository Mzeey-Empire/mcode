import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { GitPullRequest, GitBranch, ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { PICKER_PANEL_CLASS } from "@/components/ui/picker";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { BranchTargetPicker } from "@/features/conversation/composer/execution/BranchTargetPicker";
import type { BranchRefTarget } from "@/features/conversation/composer/execution/targets/branch-target";
import { useBranchTargets } from "@/features/conversation/composer/execution/targets/useBranchTargets";
import { getTransport } from "@/transport";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useToastStore } from "@/stores/toastStore";

const PreviewMarkdown = lazy(() => import("./MarkdownContent"));

// ---------------------------------------------------------------------------
// BaseBranchSelect — searchable local-branch picker for the PR dialog sidebar
// ---------------------------------------------------------------------------

interface BaseBranchSelectProps {
  workspaceId: string;
  threadId: string;
  /** The PR's own branch: listed, but it cannot be its own base. */
  headBranch: string;
  value: string;
  /** Trigger copy while no base is chosen. */
  placeholder: string;
  onChange: (name: string) => void;
  disabled?: boolean;
}

/** Searchable, paged picker for the PR base branch, listed from the thread's checkout. */
function BaseBranchSelect({ workspaceId, threadId, headBranch, value, placeholder, onChange, disabled }: BaseBranchSelectProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            aria-label="Base branch"
            className={cn(
              "flex h-8 w-full items-center justify-between rounded-lg border border-control-border bg-background pl-3 pr-2.5 text-sm transition-colors",
              "focus-visible:border-focus focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              open && "border-focus",
            )}
          >
            <span className={cn("text-fade", !value && "text-muted")}>{value || placeholder}</span>
            <ChevronDown
              className={cn("size-3.5 text-muted transition-transform duration-150", open && "rotate-180")}
              aria-hidden="true"
            />
          </button>
        }
      />
      <PopoverContent align="start" sideOffset={4} className={PICKER_PANEL_CLASS}>
        <BranchTargetPicker
          workspaceId={workspaceId}
          threadId={threadId}
          list="branches"
          value={value ? { kind: "branch", name: value } : null}
          disabledReason={(target) => (target.kind === "branch" && target.branchName === headBranch ? "Head branch" : undefined)}
          onSelect={(target) => {
            if (target.kind !== "branch") return;
            // A PR base is a GitHub branch name, so a remote-only ref drops its remote.
            onChange(target.branchName);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** Possible states for the PR creation flow. */
type DialogState = "loading" | "ready" | "submitting" | "error";
type DescriptionMode = "write" | "preview";

interface PrDialogForm {
  state: DialogState;
  setState: (state: DialogState) => void;
  error: string | null;
  setError: (error: string | null) => void;
  isRegenerating: boolean;
  setIsRegenerating: (isRegenerating: boolean) => void;
  title: string;
  setTitle: (title: string) => void;
  body: string;
  setBody: (body: string) => void;
  isDraft: boolean;
  setIsDraft: (isDraft: boolean) => void;
  descMode: DescriptionMode;
  setDescMode: (descMode: DescriptionMode) => void;
}

interface BaseBranchSelection {
  baseBranch: string;
  setBaseBranch: (branch: string) => void;
  hasValidBase: boolean;
  /** Trigger copy while no base is chosen. */
  placeholder: string;
}

interface PrDialogHeaderProps {
  branch: string;
  baseBranch: string;
  isDraft: boolean;
}

interface PrDialogSidebarProps {
  form: PrDialogForm;
  workspaceId: string;
  threadId: string;
  headBranch: string;
  baseBranchSelection: BaseBranchSelection;
  /** A load, submit or draft is in flight, so the form holds still. */
  isDisabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

interface PrDescriptionPanelProps {
  form: PrDialogForm;
  isDisabled: boolean;
  /** A draft is written against a base, so Generate waits for one. */
  hasValidBase: boolean;
  onRegenerate: () => void;
}

/** Props for the CreatePrDialog component. */
export interface CreatePrDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Callback to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** ID of the thread to create the PR from. */
  threadId: string;
  /** ID of the workspace that owns the thread. */
  workspaceId: string;
  /** Current branch name, shown in the form description. */
  branch: string;
  /** Preferred base branch selected before this dialog opens. */
  preferredBaseBranch?: string | null;
}

function usePrDialogForm(): PrDialogForm {
  const [state, setState] = useState<DialogState>("ready");
  const [error, setError] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [descMode, setDescMode] = useState<DescriptionMode>("write");

  return {
    state,
    setState,
    error,
    setError,
    isRegenerating,
    setIsRegenerating,
    title,
    setTitle,
    body,
    setBody,
    isDraft,
    setIsDraft,
    descMode,
    setDescMode,
  };
}

/**
 * The repository default branch, read from the thread's first branch page. Not the checked-out branch, which in
 * this dialog is the PR's head. `undefined` while that page loads; null when it failed or names no default.
 */
function useRepositoryDefaultBranch(request: { workspaceId: string; threadId: string } | null): string | null | undefined {
  const list = useBranchTargets(request && { ...request, purpose: "new-thread" });
  if (request === null) return undefined;
  const repositoryDefault = list.items.find((item): item is BranchRefTarget => item.kind === "branch" && item.isDefault);
  if (repositoryDefault) return repositoryDefault.branchName;
  return list.status.kind === "loading" ? undefined : null;
}

/** The base a PR session opens with: the caller's preference, else the repository default. Undefined until known. */
function initialBaseBranch(
  preferredBaseBranch: string | null | undefined,
  repositoryDefault: string | null | undefined,
  headBranch: string,
): string | undefined {
  if (preferredBaseBranch && preferredBaseBranch !== headBranch) return preferredBaseBranch;
  if (repositoryDefault === undefined) return undefined;
  return repositoryDefault === null || repositoryDefault === headBranch ? "" : repositoryDefault;
}

interface BaseBranchSession {
  readonly key: string | null;
  readonly base: string;
}

/** Holds the chosen base per PR session; `base` is undefined while the session waits for its starting base. */
function useBaseBranchSession(sessionKey: string | null, initialBase: string | undefined) {
  const [session, setSession] = useState<BaseBranchSession>({ key: null, base: "" });
  const waiting = session.key !== sessionKey;
  // Snapshot the starting base once per session, during render so the first painted frame already shows it.
  // A later pick, or a branch list refresh, never resets it.
  if (waiting && (sessionKey === null || initialBase !== undefined)) {
    setSession({ key: sessionKey, base: initialBase ?? "" });
  }
  return {
    base: waiting ? undefined : session.base,
    select: (base: string) => setSession({ key: sessionKey, base }),
  };
}

function useBaseBranchSelection(
  open: boolean,
  workspaceId: string,
  threadId: string,
  branch: string,
  preferredBaseBranch?: string | null,
): BaseBranchSelection {
  const repositoryDefault = useRepositoryDefaultBranch(open ? { workspaceId, threadId } : null);
  const sessionKey = open ? `${threadId}:${branch}:${preferredBaseBranch ?? ""}` : null;
  const session = useBaseBranchSession(sessionKey, initialBaseBranch(preferredBaseBranch, repositoryDefault, branch));
  const baseBranch = session.base ?? "";

  return {
    baseBranch,
    setBaseBranch: session.select,
    hasValidBase: baseBranch !== "" && baseBranch !== branch,
    placeholder: session.base === undefined ? "Loading branches" : "Choose branch",
  };
}

function isDialogBusy(state: DialogState, isRegenerating: boolean): boolean {
  return state === "loading" || state === "submitting" || isRegenerating;
}

function shouldAutoGenerateDraft(
  open: boolean,
  hasValidBase: boolean,
  title: string,
  body: string,
  isRegenerating: boolean,
  wasAutoGenerated: boolean,
): boolean {
  return open && hasValidBase && !title.trim() && !body.trim() && !isRegenerating && !wasAutoGenerated;
}

/**
 * Modal dialog for creating a GitHub pull request from a thread.
 * Generates an AI-powered PR draft on open, then allows the user to
 * edit the title and body before submitting.
 */
export function CreatePrDialog({
  open,
  onOpenChange,
  threadId,
  workspaceId,
  branch,
  preferredBaseBranch,
}: CreatePrDialogProps) {
  const form = usePrDialogForm();
  const {
    state: formState,
    setTitle,
    setBody,
    setIsDraft,
    setError,
    setDescMode,
    setState,
  } = form;
  const baseBranchSelection = useBaseBranchSelection(
    open,
    workspaceId,
    threadId,
    branch,
    preferredBaseBranch,
  );
  const autoGeneratedSessionKeyRef = useRef<string | null>(null);
  const baseInitializationKey = `${threadId}:${branch}:${preferredBaseBranch ?? ""}`;

  // Reset ephemeral fields when the dialog closes — but not during an in-flight
  // submission, since the close could be a forced unmount while createPr() is pending.
  useEffect(() => {
    if (!open && formState !== "submitting") {
      setTitle("");
      setBody("");
      setIsDraft(false);
      setError(null);
      setDescMode("write");
      setState("ready");
      autoGeneratedSessionKeyRef.current = null;
    }
  }, [formState, open, setBody, setDescMode, setError, setIsDraft, setState, setTitle]);

  // Keep a stable ref to onOpenChange so useCallback closures don't go stale.
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  /** Intercept close requests — block them while a submission or draft generation is in flight. */
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && (form.state === "submitting" || form.isRegenerating)) return;
    onOpenChangeRef.current(nextOpen);
  }, [form.isRegenerating, form.state]);

  const handleSubmit = useCallback(async () => {
    if (!baseBranchSelection.hasValidBase) return;
    form.setState("submitting");
    form.setError(null);
    try {
      const result = await getTransport().createPr(
        workspaceId,
        threadId,
        form.title,
        form.body,
        baseBranchSelection.baseBranch,
        form.isDraft,
      );
      useWorkspaceStore.getState().recordPrCreated(threadId, result.number, result.url);
      // Transition to ready before closing so the reset effect can clear the form.
      form.setState("ready");
      onOpenChange(false);
      useToastStore.getState().show({
        kind: "info",
        title: "Pull request created",
        meta: `PR #${result.number} opened on GitHub`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "PR creation failed";
      form.setError(message);
      form.setState("ready");
    }
  }, [workspaceId, threadId, onOpenChange, baseBranchSelection, form]);

  /** Re-run AI draft generation with the current base branch, keeping existing content visible. */
  const handleRegenerate = useCallback(async () => {
    if (!baseBranchSelection.hasValidBase) return;
    form.setIsRegenerating(true);
    form.setError(null);
    try {
      const draft = await getTransport().generatePrDraft(workspaceId, threadId, baseBranchSelection.baseBranch);
      form.setTitle(draft.title);
      form.setBody(draft.body);
    } catch (err) {
      form.setError(`Draft generation failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      form.setIsRegenerating(false);
    }
  }, [workspaceId, threadId, baseBranchSelection, form]);

  const autoGenerateSessionKey = `${threadId}:${branch}:${baseInitializationKey}`;

  // Generate an initial draft once per open when the form is still empty.
  useEffect(() => {
    const wasAutoGenerated = autoGeneratedSessionKeyRef.current === autoGenerateSessionKey;
    if (!shouldAutoGenerateDraft(
      open,
      baseBranchSelection.hasValidBase,
      form.title,
      form.body,
      form.isRegenerating,
      wasAutoGenerated,
    )) return;

    autoGeneratedSessionKeyRef.current = autoGenerateSessionKey;
    void handleRegenerate();
  }, [
    open,
    baseBranchSelection.hasValidBase,
    form.title,
    form.body,
    form.isRegenerating,
    autoGenerateSessionKey,
    handleRegenerate,
  ]);

  const isDisabled = isDialogBusy(form.state, form.isRegenerating);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-4xl w-[min(90vw,900px)] gap-0 overflow-hidden p-0"
        showCloseButton={!isDisabled}
      >
        <PrDialogHeader
          branch={branch}
          baseBranch={baseBranchSelection.baseBranch}
          isDraft={form.isDraft}
        />

        <div className="flex min-h-[320px] max-h-[min(480px,70vh)] max-sm:max-h-[min(640px,85vh)] max-sm:flex-col">
          <PrDialogSidebar
            form={form}
            workspaceId={workspaceId}
            threadId={threadId}
            headBranch={branch}
            baseBranchSelection={baseBranchSelection}
            isDisabled={isDisabled}
            onSubmit={handleSubmit}
            onCancel={() => onOpenChange(false)}
          />

          <PrDescriptionPanel
            form={form}
            isDisabled={isDisabled}
            hasValidBase={baseBranchSelection.hasValidBase}
            onRegenerate={handleRegenerate}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PrDialogHeader({ branch, baseBranch, isDraft }: PrDialogHeaderProps) {
  return (
    <div className="flex items-center gap-3 border-b border-border/50 py-4 pl-5 pr-12">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-hover/40">
        <GitPullRequest className="size-3.5 text-muted" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <DialogTitle className="text-sm font-medium leading-none">Create pull request</DialogTitle>
        <DialogDescription className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
          <span className="min-w-0 max-w-[min(200px,40vw)] text-fade font-mono text-ink/80">
            {branch}
          </span>
          <span className="shrink-0 text-muted/50" aria-hidden="true">→</span>
          <span className="min-w-0 max-w-[min(200px,40vw)] text-fade font-mono text-muted">
            {baseBranch}
          </span>
        </DialogDescription>
      </div>
      {isDraft && (
        <span className="shrink-0 rounded border border-border/50 bg-hover/60 px-2 py-0.5 text-xs text-muted">
          Draft
        </span>
      )}
    </div>
  );
}

function PrDialogSidebar({
  form,
  workspaceId,
  threadId,
  headBranch,
  baseBranchSelection,
  isDisabled,
  onSubmit,
  onCancel,
}: PrDialogSidebarProps) {
  return (
    <div className="flex min-h-0 w-64 shrink-0 flex-col gap-4 border-r border-border/50 p-5 max-sm:w-full max-sm:border-r-0 max-sm:border-b max-sm:border-border/50">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="pr-title" className="text-xs text-muted">
          Title
        </label>
        <Input
          id="pr-title"
          value={form.title}
          onChange={(event) => form.setTitle(event.target.value)}
          placeholder="PR title"
          disabled={isDisabled}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-1 text-xs text-muted">
          <GitBranch className="size-3" aria-hidden="true" />
          Base branch
        </label>
        <BaseBranchSelect
          workspaceId={workspaceId}
          threadId={threadId}
          headBranch={headBranch}
          value={baseBranchSelection.baseBranch}
          placeholder={baseBranchSelection.placeholder}
          onChange={baseBranchSelection.setBaseBranch}
          disabled={isDisabled}
        />
      </div>

      <div className="flex items-center justify-between">
        <label
          htmlFor="pr-is-draft"
          className="cursor-pointer select-none text-xs text-muted"
        >
          Draft PR
        </label>
        <Switch
          id="pr-is-draft"
          checked={form.isDraft}
          onCheckedChange={form.setIsDraft}
          disabled={isDisabled}
        />
      </div>

      <div className="flex-1" />

      {form.error && (
        <div
          role="alert"
          className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {form.error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Button
          onClick={onSubmit}
          disabled={isDisabled || !baseBranchSelection.hasValidBase || !form.title.trim()}
          className="w-full gap-1.5"
        >
          {form.state === "submitting" && <Spinner size={16} className="text-current" />}
          Create PR
        </Button>
        <Button
          variant="ghost"
          onClick={onCancel}
          disabled={isDisabled}
          className="w-full"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PrDescriptionPanel({ form, isDisabled, hasValidBase, onRegenerate }: PrDescriptionPanelProps) {
  if (form.isRegenerating && !form.body) {
    return <PrDraftLoadingState />;
  }

  return (
    <PrDescriptionEditor
      form={form}
      isDisabled={isDisabled}
      hasValidBase={hasValidBase}
      onRegenerate={onRegenerate}
    />
  );
}

function PrDraftLoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-1 items-center justify-center gap-2 text-sm text-muted"
    >
      <Spinner size={16} className="text-muted" />
      Generating PR draft…
    </div>
  );
}

function PrDescriptionEditor({ form, isDisabled, hasValidBase, onRegenerate }: PrDescriptionPanelProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-5">
      <div className="flex items-center justify-between">
        <label htmlFor="pr-body" className="text-xs text-muted">
          Description
        </label>
        <div className="flex items-center gap-2">
          <PrDraftGenerationButton
            isRegenerating={form.isRegenerating}
            hasDraftContent={Boolean(form.title || form.body)}
            disabled={isDisabled || !hasValidBase}
            onRegenerate={onRegenerate}
          />
          <SegmentedControl
            options={[
              { value: "write", label: "Write" },
              { value: "preview", label: "Preview" },
            ]}
            value={form.descMode}
            onChange={(mode) => form.setDescMode(mode as DescriptionMode)}
          />
        </div>
      </div>
      <PrDescriptionField form={form} isDisabled={isDisabled} />
    </div>
  );
}

function PrDraftGenerationButton({
  isRegenerating,
  hasDraftContent,
  disabled,
  onRegenerate,
}: {
  isRegenerating: boolean;
  hasDraftContent: boolean;
  disabled: boolean;
  onRegenerate: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="compact"
      onClick={onRegenerate}
      disabled={disabled}
      className="h-6 gap-1.5 px-2 text-xs text-muted hover:text-ink"
    >
      {isRegenerating ? (
        <Spinner size={12} className="text-current" />
      ) : (
        <RefreshCw className="size-3" aria-hidden="true" />
      )}
      {hasDraftContent ? "Regenerate" : "Generate"}
    </Button>
  );
}

function PrDescriptionField({ form, isDisabled }: Pick<PrDescriptionPanelProps, "form" | "isDisabled">) {
  if (form.descMode === "write") {
    return (
      <textarea
        id="pr-body"
        value={form.body}
        onChange={(event) => form.setBody(event.target.value)}
        disabled={isDisabled}
        placeholder="PR description"
        className={cn(
          "flex-1 min-h-0 w-full rounded-lg border border-control-border bg-background px-3 py-2.5 text-sm transition-colors",
          "font-mono resize-none overflow-y-auto",
          "placeholder:text-muted",
          "focus-visible:border-focus focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      />
    );
  }

  return <PrMarkdownPreview body={form.body} />;
}

function PrMarkdownPreview({ body }: { body: string }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-control-border bg-background px-3 py-2.5 text-sm">
      {body.trim() ? (
        <Suspense fallback={<span className="text-sm text-muted">Loading preview…</span>}>
          <PreviewMarkdown content={body} />
        </Suspense>
      ) : (
        <span className="italic text-muted">Nothing to preview.</span>
      )}
    </div>
  );
}
