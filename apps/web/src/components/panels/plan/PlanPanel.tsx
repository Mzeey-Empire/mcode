import { useEffect, useSyncExternalStore } from "react";
import type { PlanVersion } from "@mcode/contracts";
import { isPlanVersionEditable, selectViewedPlanVersion, usePlanStore } from "@/stores/planStore";
import { isThreadExecuting, useThreadStore } from "@/stores/threadStore";
import { PlanConflictNotice } from "./PlanConflictNotice";
import { PlanEditor } from "./PlanEditor";
import { PlanPanelHeader } from "./PlanPanelHeader";
import { planSaveScheduler } from "./plan-draft-sessions";

/** Stable empty array to avoid new-reference-per-render in Zustand selectors. */
const EMPTY_PLANS: readonly PlanVersion[] = [];

/** Props for {@link PlanPanel}. */
interface PlanPanelProps {
  readonly threadId: string;
}

/**
 * Plan tab content: the version picker in the panel header and the plan
 * editor. Typing into the latest draft or ready version autosaves it as a
 * draft. Renders nothing until the thread has a plan.
 */
export function PlanPanel({ threadId }: PlanPanelProps) {
  const versions = usePlanStore((s) => s.plansByThread[threadId] ?? EMPTY_PLANS);
  const activeVersion = usePlanStore((s) => s.activeVersionByThread[threadId] ?? null);
  const executing = useThreadStore((s) => isThreadExecuting(threadId, s));
  const scheduler = planSaveScheduler(threadId);
  const draft = useSyncExternalStore(scheduler.subscribe, scheduler.getSnapshot);
  const viewed = selectViewedPlanVersion(versions, activeVersion);
  const latest = versions.at(-1) ?? null;

  useEffect(() => scheduler.reconcile(latest), [scheduler, latest]);
  // Closing the panel or switching threads must not strand debounced text.
  useEffect(() => () => scheduler.flush(), [scheduler]);

  if (!viewed || !latest) return null;

  const viewingLatest = viewed.id === latest.id;
  const heldText = draft.kind === "idle" ? null : draft.text;

  return (
    <div className="flex min-h-0 flex-1 basis-0 flex-col overflow-hidden">
      <PlanPanelHeader threadId={threadId} versions={versions} viewed={viewed} />
      {draft.kind === "conflict" && (
        <PlanConflictNotice canKeep={draft.canKeep} onKeepMine={() => scheduler.keepMine()} onUseSaved={() => scheduler.useSaved()} />
      )}
      <PlanEditor
        contentMd={viewingLatest && heldText !== null ? heldText : viewed.contentMd}
        editable={draft.kind !== "conflict" && isPlanVersionEditable(viewed, latest, executing)}
        onChange={(text) => scheduler.edit(text, latest)}
        onBlur={() => scheduler.flush()}
      />
    </div>
  );
}
