import { useEffect, useSyncExternalStore } from "react";
import type { PlanVersion } from "@mcode/contracts";
import { isPlanVersionEditable, selectViewedPlanVersion, usePlanStore } from "@/stores/planStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { useDiffStore } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { PlanConflictNotice } from "./PlanConflictNotice";
import { PlanEditor } from "./PlanEditor";
import { PlanPanelHeader } from "./PlanPanelHeader";
import { planSaveScheduler } from "./plan-draft-sessions";
import { dismissImplementNotice, showPlanPanel, usePlanImplementStore } from "./plan-implement";

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
  const executing = useThreadStore((s) => isThreadExecuting(threadId, s));
  const scheduler = planSaveScheduler(threadId);
  const draft = useSyncExternalStore(scheduler.subscribe, scheduler.getSnapshot);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  // The right panel stays mounted while hidden, so mounting alone does not put the plan on screen.
  const onScreen = useDiffStore((s) => workspaceId !== null && s.getRightPanelVisible(workspaceId, threadId));
  const viewed = selectViewedPlanVersion(versions, activeVersion);
  const latest = versions.at(-1) ?? null;

  useEffect(() => scheduler.reconcile(latest), [scheduler, latest]);
  // Closing the panel or switching threads must not strand debounced text.
  useEffect(() => () => scheduler.flush(), [scheduler]);
  useEffect(() => (onScreen ? showPlanPanel(threadId) : undefined), [onScreen, threadId]);

  if (!viewed || !latest) return null;

  const heldText = viewed.id === latest.id && draft.kind !== "idle" ? draft.text : null;

  return (
    <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
      <PlanPanelHeader threadId={threadId} versions={versions} viewed={viewed} executing={executing} />
      {draft.kind === "conflict" && (
        <PlanConflictNotice canKeep={draft.canKeep} onKeepMine={() => scheduler.keepMine()} onUseSaved={() => scheduler.useSaved()} />
      )}
      <PlanImplementNotice threadId={threadId} />
      <PlanEditor
        contentMd={heldText ?? viewed.contentMd}
        editable={(draft.kind === "idle" || draft.kind === "editing") && isPlanVersionEditable(viewed, latest, executing)}
        onChange={(text) => {
          // Only the latest version is editable, and the first save makes a
          // newer one, so a pinned pick must follow it or the edit vanishes.
          if (activeVersion !== null) usePlanStore.getState().setActiveVersion(threadId, null);
          dismissImplementNotice(threadId);
          scheduler.edit(text, latest);
        }}
        onBlur={() => scheduler.flush()}
      />
    </div>
  );
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
