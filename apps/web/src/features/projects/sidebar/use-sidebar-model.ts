import { useEffect, useMemo, useRef, useState } from "react";
import { threadAttentionNeedsUser, type ThreadAttention } from "@mcode/contracts/models/thread-attention";
import { threadAttentionStore } from "@/features/thread-attention/thread-attention-store";
import { useSettingsStore } from "@/stores/settingsStore";
import { useThreadDraftStore, type ThreadDraft } from "@/stores/threadDraftStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { selectSidebarFacts } from "../state/thread-index";
import {
  deriveSidebarModel,
  reconcileItems,
  trackNeedsUserEnds,
  type ModelCause,
  type SidebarInputs,
  type SidebarModel,
  type SidebarModelUi,
} from "./sidebar-model";
import { useSidebarUiStore } from "./sidebar-ui-store";
import { useCompletionStore } from "./completion-store";

const NO_IDS: ReadonlySet<string> = new Set();
const NO_ENDS: ReadonlyMap<string, number> = new Map();

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function needsUserSet(byThreadId: Readonly<Record<string, ThreadAttention>>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [id, attention] of Object.entries(byThreadId)) if (threadAttentionNeedsUser(attention)) ids.add(id);
  return ids;
}

function draftIdsByWorkspace(drafts: Readonly<Record<string, ThreadDraft>>): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, ThreadDraft[]>();
  for (const draft of Object.values(drafts)) {
    const list = grouped.get(draft.workspaceId);
    if (list) list.push(draft);
    else grouped.set(draft.workspaceId, [draft]);
  }
  return new Map([...grouped].map(([workspaceId, list]) => [workspaceId, list.sort((a, b) => b.updatedAt - a.updatedAt).map((draft) => draft.id)]));
}

function useNeedsUserIds(): ReadonlySet<string> {
  const byThreadId = threadAttentionStore((state) => state.byThreadId);
  const previous = useRef<ReadonlySet<string>>(NO_IDS);
  return useMemo(() => {
    const next = needsUserSet(byThreadId);
    if (sameMembers(previous.current, next)) return previous.current;
    previous.current = next;
    return next;
  }, [byThreadId]);
}

function useNeedsUserEndedAt(needsUserIds: ReadonlySet<string>): ReadonlyMap<string, number> {
  const tracked = useRef({ ids: NO_IDS, ends: NO_ENDS });
  return useMemo(() => {
    const ends = trackNeedsUserEnds(tracked.current.ends, tracked.current.ids, needsUserIds, Date.now());
    tracked.current = { ids: needsUserIds, ends };
    return ends;
  }, [needsUserIds]);
}

function useModelUi(): SidebarModelUi {
  const scope = useSidebarUiStore((state) => state.scope);
  const view = useSidebarUiStore((state) => state.view);
  const olderOpen = useSidebarUiStore((state) => state.olderOpen);
  const collapsedProjects = useSidebarUiStore((state) => state.collapsedProjects);
  const collapsedOlderProjects = useSidebarUiStore((state) => state.collapsedOlderProjects);
  const showMore = useSidebarUiStore((state) => state.showMore);
  const frozen = useSidebarUiStore((state) => state.frozen);
  return useMemo(
    () => ({ scope, view, olderOpen, collapsedProjects, collapsedOlderProjects, showMore, frozen }),
    [scope, view, olderOpen, collapsedProjects, collapsedOlderProjects, showMore, frozen],
  );
}

function useClockTicks(nextBoundaryAt: number | null, setNow: (now: number) => void): void {
  useEffect(() => {
    if (nextBoundaryAt === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, nextBoundaryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [nextBoundaryAt, setNow]);
  useEffect(() => {
    const onFocus = () => setNow(Date.now());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [setNow]);
}

function useSidebarInputs(now: number): SidebarInputs {
  const threads = useWorkspaceStore((state) => state.threads);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const selectedThreadId = useWorkspaceStore((state) => state.activeThreadId);
  const snapshotEpoch = useWorkspaceStore((state) => state.threadSnapshotEpoch);
  const drafts = useThreadDraftStore((state) => state.drafts);
  const olderAfterDays = useSettingsStore((state) => state.settings.thread.olderAfterDays);
  const completions = useCompletionStore((state) => state.entries);
  const needsUserIds = useNeedsUserIds();
  const needsUserEndedAt = useNeedsUserEndedAt(needsUserIds);
  const ui = useModelUi();
  const facts = selectSidebarFacts(threads);
  const projectOrder = useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces]);
  const draftsByWorkspace = useMemo(() => draftIdsByWorkspace(drafts), [drafts]);
  return useMemo(
    () => ({ facts, projectOrder, draftsByWorkspace, needsUserIds, needsUserEndedAt, completions, olderAfterDays, ui, selectedThreadId, now, snapshotEpoch }),
    [facts, projectOrder, draftsByWorkspace, needsUserIds, needsUserEndedAt, completions, olderAfterDays, ui, selectedThreadId, now, snapshotEpoch],
  );
}

/**
 * Returns the live sidebar model and change cause, preserving equal item identities and
 * refreshing time at Older boundaries and on window focus.
 */
export function useSidebarModel(): { readonly model: SidebarModel; readonly cause: ModelCause } {
  const [now, setNow] = useState(Date.now);
  const inputs = useSidebarInputs(now);
  const previous = useRef<{ inputs: SidebarInputs; model: SidebarModel } | null>(null);
  const result = useMemo(() => {
    const prior = previous.current;
    const derived = deriveSidebarModel(inputs);
    const model = prior ? { ...derived, items: reconcileItems(prior.model.items, derived.items) } : derived;
    const cause = classifyCause(prior?.inputs ?? null, inputs);
    previous.current = { inputs, model };
    return { model, cause };
  }, [inputs]);
  useClockTicks(result.model.nextBoundaryAt, setNow);
  return result;
}

function layoutChanged(prev: SidebarInputs, next: SidebarInputs): boolean {
  return prev.ui.scope !== next.ui.scope || prev.ui.view !== next.ui.view
    || prev.ui.olderOpen !== next.ui.olderOpen || prev.olderAfterDays !== next.olderAfterDays;
}

function onlyClockChanged(prev: SidebarInputs, next: SidebarInputs): boolean {
  return prev.now !== next.now && prev.facts === next.facts && prev.completions === next.completions
    && prev.needsUserIds === next.needsUserIds && prev.ui === next.ui && prev.selectedThreadId === next.selectedThreadId
    && prev.draftsByWorkspace === next.draftsByWorkspace && prev.projectOrder === next.projectOrder;
}

/**
 * Classifies a model change. The first model and any change carrying a new snapshot epoch
 * (hydration, reconnect) are `snapshot`, which never animates; scope, view, threshold and Older
 * open are `layout`; time alone is `clock`; everything else is a live `push`.
 */
export function classifyCause(prev: SidebarInputs | null, next: SidebarInputs): ModelCause {
  if (prev === null || prev.snapshotEpoch !== next.snapshotEpoch) return "snapshot";
  if (layoutChanged(prev, next)) return "layout";
  if (onlyClockChanged(prev, next)) return "clock";
  return "push";
}
