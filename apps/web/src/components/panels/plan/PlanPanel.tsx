import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import type { PlanVersion } from "@mcode/contracts/models/plan";
import { isPlanVersionEditable, selectViewedPlanVersion, usePlanStore } from "@/stores/planStore";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { Button } from "@/components/ui/button";
import { PlanCommentLayer } from "./PlanCommentLayer";
import { createPlanCommentBinding } from "./plan-comment-extension";
import { PlanConflictNotice } from "./PlanConflictNotice";
import { PlanEditor } from "./PlanEditor";
import { PlanPanelHeader } from "./PlanPanelHeader";
import { planSaveScheduler } from "./plan-draft-sessions";
import type { PlanDraftState } from "./plan-save-scheduler";
import { dismissImplementNotice, showPlanPanel, usePlanImplementStore } from "./plan-implement";
import { useWaitingForSetup, type PlanWaitingForSetup } from "./use-waiting-for-setup";

/** Stable empty array to avoid new-reference-per-render in Zustand selectors. */
const EMPTY_PLANS: readonly PlanVersion[] = [];

/** Props for {@link PlanPanel}. */
interface PlanPanelProps {
  readonly threadId: string;
}

/**
 * Plan tab content: the version picker and Implement split in the panel
 * header, and the plan editor. Typing into the latest draft or ready version
 * autosaves it as a draft. Renders nothing until the thread has a plan.
 */
export function PlanPanel({ threadId }: PlanPanelProps) {
  const versions = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const activeVersion = usePlanStore((s) => s.activeVersionByThread[threadId] ?? null);
  const turnRunning = useThreadStore((s) => isThreadExecuting(threadId, s));
  const scheduler = planSaveScheduler(threadId);
  const draft = useSyncExternalStore(scheduler.subscribe, scheduler.getSnapshot);
  const viewed = selectViewedPlanVersion(versions, activeVersion);
  const latest = versions.at(-1) ?? null;
  const waiting = useWaitingForSetup(threadId);
  // Setup holds the source's reservation, so the server refuses plan writes exactly as during a run.
  const executing = turnRunning || waiting !== null;
  const [commentBinding] = useState(createPlanCommentBinding);
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  useShowCommentEditorVersion(threadId, versions);
  useRegisterPlanPanelVisibility(threadId);
  useEffect(() => scheduler.reconcile(latest), [scheduler, latest]);
  // Closing the panel or switching threads must not strand debounced text.
  useEffect(() => () => scheduler.flush(), [scheduler]);

  if (!viewed || !latest) return null;

  const { heldText, editable, canComment } = planEditorAccess(viewed, latest, draft, executing);

  return (
    <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
      <PlanPanelHeader threadId={threadId} versions={versions} viewed={viewed} executing={executing} />
      {draft.kind === "conflict" && (
        <PlanConflictNotice canKeep={draft.canKeep} onKeepMine={() => scheduler.keepMine()} onUseSaved={() => scheduler.useSaved()} />
      )}
      <PlanImplementNotice threadId={threadId} />
      {waiting && <PlanWaitingNotice waiting={waiting} />}
      <PlanEditor
        contentMd={heldText ?? viewed.contentMd}
        editable={editable}
        onChange={(text) => {
          // Only the latest version is editable, and the first save makes a
          // newer one, so a pinned pick must follow it or the edit vanishes.
          if (activeVersion !== null) usePlanStore.getState().setActiveVersion(threadId, null);
          dismissImplementNotice(threadId);
          scheduler.edit(text, latest);
        }}
        onBlur={() => scheduler.flush()}
        extensions={commentBinding.extension}
        onViewChange={setEditorView}
      />
      <PlanCommentLayer
        threadId={threadId}
        binding={commentBinding}
        view={editorView}
        viewed={viewed}
        docText={heldText ?? viewed.contentMd}
        canComment={canComment}
      />
    </div>
  );
}

/**
 * A note left open reopens on the version it was written on, even after a
 * newer one exists. Runs once per thread so the version picker stays free.
 */
function useShowCommentEditorVersion(threadId: string, versions: readonly PlanVersion[]): void {
  const editorVersionId = useComposerDraftStore((s) => s.drafts[threadId]?.planCommentEditor?.planVersionId);
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (restoredFor.current === threadId || versions.length === 0) return;
    restoredFor.current = threadId;
    const target = versions.find((version) => version.id === editorVersionId);
    if (target && target !== versions.at(-1)) usePlanStore.getState().setActiveVersion(threadId, target.version);
  }, [threadId, versions, editorVersionId]);
}

/** True when the text on screen is what the server holds: no session, or one whose last edit was acknowledged. */
function isSavedText(draft: PlanDraftState): boolean {
  return draft.kind === "idle" || (draft.kind === "editing" && draft.inFlight === null && draft.text === draft.ackedText);
}

/**
 * What the editor shows and allows. Unsaved typing is held text; commenting
 * on the latest version waits for it to land because the server checks a
 * comment's range against the saved text.
 */
export function planEditorAccess(viewed: PlanVersion, latest: PlanVersion, draft: PlanDraftState, executing: boolean) {
  const isLatest = viewed.id === latest.id;
  return {
    heldText: isLatest && draft.kind !== "idle" ? draft.text : null,
    editable: (draft.kind === "idle" || draft.kind === "editing") && isPlanVersionEditable(viewed, latest, executing),
    // The server refuses comments on an accepted version and while a run is busy.
    canComment: viewed.status !== "accepted" && !executing && (!isLatest || isSavedText(draft)),
  };
}

function PlanImplementNotice({ threadId }: { readonly threadId: string }) {
  const notice = usePlanImplementStore((s) => s.notices[threadId] ?? null);
  if (notice === null) return null;
  return (
    <div role="status" data-testid="plan-implement-notice" className="shrink-0 border-b border-border px-6 py-2 text-sm text-ink">
      {notice}
    </div>
  );
}

function PlanWaitingNotice({ waiting }: { readonly waiting: PlanWaitingForSetup }) {
  return (
    <div role="status" data-testid="plan-waiting-notice" className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-2 text-sm text-muted">
      <span className="min-w-0 flex-1 text-fade">Waiting for Setup in {waiting.folder ?? "the new worktree"}</span>
      <Button variant="outline" size="compact" onClick={() => useWorkspaceStore.getState().setActiveThread(waiting.targetThreadId)}>
        Open thread
      </Button>
    </div>
  );
}

function useRegisterPlanPanelVisibility(threadId: string): void {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const visible = useDiffStore((s) => workspaceId !== null && s.getRightPanelVisible(workspaceId, threadId));
  useEffect(() => (visible ? showPlanPanel(threadId) : undefined), [visible, threadId]);
}
