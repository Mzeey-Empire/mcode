import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { SubagentRoster, SubagentRosterEntry, CanonicalSubagentStopResult } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { getTransport } from "@/transport";
import { formatRelative } from "@/lib/format-relative";
import { getConversationResidency, MessageList, SubagentProviderScope } from "@/features/conversation";
import { SubagentStopControl } from "../lifecycle/SubagentStopControl";
import { useClearSubagentDetail, useSelectSubagentDetail, useSubagentDetailSelection } from "../state";
import { useSubagentRoster, useSubagentRosterStore } from "../state/subagentRosterStore";
import { subagentStatusLabel } from "../subagent-status";
import { NarrativeDetailView } from "../detail/NarrativeDetailView";
import { openSubagentDetail, openSubagentsRoster } from "../detail/open-subagent-detail";

type StopAllTarget = { readonly id: string; readonly owningParentThreadId: string; readonly identity: string; readonly lineage: string };
type StopAllTargetStatus = "idle" | "pending" | "success" | "failed";

function stopAllStatusLabel(status: StopAllTargetStatus): string | null {
  switch (status) {
    case "pending": return "Stopping";
    case "success": return "Stopped";
    case "failed": return "Failed";
    default: return null;
  }
}

function RosterRow({ row, onSelect, onStop, onTerminal }: {
  row: SubagentRosterEntry; onSelect: () => void;
  onStop: () => Promise<CanonicalSubagentStopResult>; onTerminal: () => Promise<void>;
}) {
  const active = row.status === "running";
  const configuration = [row.subagentType, row.model, row.stepCount > 0 ? `${row.stepCount} steps` : null].filter(Boolean).join(" · ");
  return (
    <div data-testid={active ? "subagent-active-row" : "subagent-finished-row"} className="flex w-full min-w-0 items-center rounded-none transition-colors duration-150 motion-reduce:transition-none hover:bg-hover/30">
      <Button type="button" variant="ghost" onClick={onSelect}
        aria-label={`Open ${row.title} details, ${subagentStatusLabel(row.status)}`} data-subagent-id={row.id}
        className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none px-6 py-2.5 text-left focus-visible:ring-inset">
        <ProviderIcon provider={row.provider} size={20} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 text-fade text-sm font-medium text-ink">{row.title}</span>
            <span className="shrink-0 font-mono text-xs text-muted">{subagentStatusLabel(row.status)}</span>
            {row.endedAt && <time dateTime={row.endedAt} className="shrink-0 font-mono text-xs text-muted">{formatRelative(row.endedAt)}</time>}
          </span>
          {configuration && <span className="mt-0.5 block text-fade font-mono text-xs text-muted">{configuration}</span>}
        </span>
      </Button>
      <SubagentStopControl active={active} canStop={row.canStop} label={row.title} onStop={onStop} onTerminal={onTerminal} className="mr-3" />
    </div>
  );
}

function TranscriptDetail({ row, childThreadId, onBack, onStop, onTerminal }: {
  row: SubagentRosterEntry; childThreadId: string; onBack: () => void;
  onStop: () => Promise<CanonicalSubagentStopResult>; onTerminal: () => Promise<void>;
}) {
  useEffect(() => {
    const residency = getConversationResidency();
    residency.mountDisplayConversation(childThreadId);
    return () => residency.unmountDisplayConversation(childThreadId);
  }, [childThreadId]);
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={`${row.title} subagent details`}>
    <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
      <Button type="button" variant="ghost" size="icon-compact" onClick={onBack} aria-label="Back to subagents"><ArrowLeft size={15} aria-hidden /></Button>
      <ProviderIcon provider={row.provider} size={20} />
      <h2 className="text-fade text-sm font-semibold">{row.title}</h2>
      <span role="status" className="sr-only">{subagentStatusLabel(row.status)}</span>
    </header>
    <div className="min-h-0 flex-1"><MessageList displayThreadId={childThreadId} onSubagentSelect={openSubagentDetail} onOpenSubagents={openSubagentsRoster} /></div>
    {row.status === "running" && row.canStop && <div data-testid="subagent-detail-actions" className="flex shrink-0 justify-end border-t border-border/40 px-4 py-2">
      <SubagentStopControl active canStop label={row.title} onStop={onStop} onTerminal={onTerminal} />
    </div>}
  </section>;
}

function StopAllConfirmationDialog({
  open,
  targets,
  statuses,
  batchActive,
  triggerRef,
  panelRef,
  cancelRef,
  onOpenChange,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly targets: readonly StopAllTarget[] | null;
  readonly statuses: ReadonlyMap<string, StopAllTargetStatus>;
  readonly batchActive: boolean;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly panelRef: React.RefObject<HTMLElement | null>;
  readonly cancelRef: React.RefObject<HTMLButtonElement | null>;
  readonly onOpenChange: (open: boolean, eventDetails: { cancel: () => void }) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  if (!targets) return null;
  const failedCount = targets.filter((target) => statuses.get(target.id) === "failed").length;
  const actionLabel = batchActive
    ? "Stopping…"
    : failedCount > 0
      ? "Retry failed"
      : "Stop all";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-2xl [&_[data-slot=dialog-close]]:right-4 [&_[data-slot=dialog-close]]:top-4"
        initialFocus={cancelRef}
        finalFocus={() => {
          const trigger = triggerRef.current;
          return trigger?.isConnected ? trigger : panelRef.current;
        }}
        showCloseButton={!batchActive}
        aria-busy={batchActive}
      >
        <DialogHeader className="gap-2 pb-5 pl-6 pr-16 pt-6">
          <DialogTitle className="text-lg leading-6">Stop all active sub-agents?</DialogTitle>
          <DialogDescription className="max-w-md leading-5">
            This stops the active sub-agents below. Unfinished output may be lost.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-6">
          <ul
            aria-label="Sub-agents to stop"
            aria-live="polite"
            className="max-h-64 divide-y divide-border/60 overflow-y-auto border-y border-border/60"
          >
            {targets.map((target) => {
              const status = statuses.get(target.id) ?? "idle";
              const statusLabel = stopAllStatusLabel(status);
              return (
                <li key={target.id} className="flex min-h-12 items-center justify-between gap-6 py-3 text-sm">
                  <span className="min-w-0 text-ink">
                    <span className="block font-medium leading-5">{target.identity}</span>
                    {target.lineage && (
                      <span className="mt-1 block text-xs leading-4 text-muted">
                        Lineage: {target.lineage}
                      </span>
                    )}
                  </span>
                  {statusLabel && (
                    <span className={`shrink-0 text-xs ${status === "failed" ? "text-destructive" : "text-muted"}`}>
                      {statusLabel}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {failedCount > 0 && (
            <p role="alert" data-testid="subagent-stop-all-failure-summary" className="mt-4 text-sm text-destructive">
              {failedCount} stop{failedCount === 1 ? "" : "s"} failed. Retry will try only failed sub-agents.
            </p>
          )}
        </div>
        <DialogFooter className="!mx-0 !mb-0 gap-3 rounded-none rounded-b-xl px-6 py-4">
          <Button ref={cancelRef} variant="outline" size="compact" onClick={onCancel} disabled={batchActive} autoFocus>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="compact"
            onClick={onConfirm}
            disabled={batchActive}
            aria-busy={batchActive}
          >
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


function useStopAllControl(
  threadId: string,
  canonicalRoster: SubagentRoster | null,
  refreshRoster: () => Promise<void>,
): {
  readonly open: boolean;
  readonly targets: readonly StopAllTarget[] | null;
  readonly statuses: ReadonlyMap<string, StopAllTargetStatus>;
  readonly batchActive: boolean;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly panelRef: React.RefObject<HTMLElement | null>;
  readonly cancelRef: React.RefObject<HTMLButtonElement | null>;
  readonly openStopAll: () => void;
  readonly onOpenChange: (nextOpen: boolean, eventDetails: { cancel: () => void }) => void;
  readonly confirm: () => void;
} {
  const stopAllTriggerRef = useRef<HTMLButtonElement | null>(null);
  const subagentsPanelRef = useRef<HTMLElement | null>(null);
  const stopAllCancelRef = useRef<HTMLButtonElement | null>(null);
  const stopAllBatchRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [stopAllTargets, setStopAllTargets] = useState<readonly StopAllTarget[] | null>(null);
  const [stopAllStatuses, setStopAllStatuses] = useState<ReadonlyMap<string, StopAllTargetStatus>>(new Map());
  const [stopAllBatchActive, setStopAllBatchActive] = useState(false);
  useEffect(() => () => { lifecycleGenerationRef.current += 1; }, []);

  const openStopAll = () => {
    if (stopAllBatchRef.current || stopAllBatchActive || !canonicalRoster) return;
    const eligibleTargets = canonicalRoster.entries.filter((row) => row.status === "running")
      .filter((row) => row.canStop)
      .map((row) => ({
        id: row.childThreadId ?? row.id,
        owningParentThreadId: threadId,
        identity: row.title,
        lineage: "",
      }));
    if (eligibleTargets.length < 2) return;
    setStopAllTargets(eligibleTargets);
    setStopAllStatuses(new Map(eligibleTargets.map((target) => [target.id, "idle" as const])));
    setStopAllOpen(true);
  };

  const handleStopAllOpenChange = (nextOpen: boolean, eventDetails: { cancel: () => void }) => {
    if (nextOpen) return;
    if (stopAllBatchRef.current || stopAllBatchActive) {
      eventDetails.cancel();
      return;
    }
    setStopAllOpen(false);
    setStopAllTargets(null);
    setStopAllStatuses(new Map());
  };

  const runStopAllBatch = async (targets: readonly StopAllTarget[]) => {
    if (stopAllBatchRef.current || stopAllBatchActive || targets.length === 0) return;
    const batchGeneration = lifecycleGenerationRef.current;
    stopAllBatchRef.current = true;
    setStopAllBatchActive(true);
    setStopAllStatuses((previous) => {
      const next = new Map(previous);
      for (const target of targets) next.set(target.id, "pending");
      return next;
    });
    const outcomes = await Promise.all(targets.map(async (target) => {
      let success = false;
      try {
        const result = await getTransport().stopCanonicalSubagent(target.owningParentThreadId, target.id);
        success = result.status === "interrupted" || result.status === "already-terminal";
      } catch {
        console.error("Canonical subagent stop failed");
      }
      if (lifecycleGenerationRef.current !== batchGeneration) return null;
      setStopAllStatuses((previous) => {
        const next = new Map(previous);
        next.set(target.id, success ? "success" : "failed");
        return next;
      });
      if (success) {
        if (lifecycleGenerationRef.current !== batchGeneration) return null;
        await refreshRoster();
        if (lifecycleGenerationRef.current !== batchGeneration) return null;
      }
      return success;
    }));
    if (lifecycleGenerationRef.current !== batchGeneration) return;
    stopAllBatchRef.current = false;
    setStopAllBatchActive(false);
    if (outcomes.every(Boolean)) {
      setStopAllOpen(false);
      setStopAllTargets(null);
      setStopAllStatuses(new Map());
    }
  };

  const confirm = () => {
    if (!stopAllTargets || stopAllBatchRef.current || stopAllBatchActive) return;
    const targets = stopAllTargets.filter((target) => {
      const status = stopAllStatuses.get(target.id) ?? "idle";
      return status === "idle" || status === "failed";
    });
    void runStopAllBatch(targets);
  };
  return {
    open: stopAllOpen,
    targets: stopAllTargets,
    statuses: stopAllStatuses,
    batchActive: stopAllBatchActive,
    triggerRef: stopAllTriggerRef,
    panelRef: subagentsPanelRef,
    cancelRef: stopAllCancelRef,
    openStopAll,
    onOpenChange: handleStopAllOpenChange,
    confirm,
  };
}



/** Render the shared server roster with the existing list and detail presentation. */
export function SubagentsPanel({ threadId }: { readonly threadId: string }) {
  return <SubagentProviderScope threadId={threadId}><SubagentsPanelContent key={threadId} threadId={threadId} /></SubagentProviderScope>;
}

function SubagentsPanelContent({ threadId }: { readonly threadId: string }) {
  const roster = useSubagentRoster(threadId);
  const error = useSubagentRosterStore((state) => state.errors.has(threadId));
  const refresh = () => useSubagentRosterStore.getState().refresh(threadId);
  const selection = useSubagentDetailSelection(threadId);
  const selectDetail = useSelectSubagentDetail();
  const clearDetail = useClearSubagentDetail();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stopAll = useStopAllControl(threadId, roster ?? null, refresh);
  const selected = roster?.entries.find((entry) => entry.id === selection?.id);
  const stopRow = (row: SubagentRosterEntry) => {
    if (!row.childThreadId) return Promise.reject(new Error("Subagent cannot be stopped independently"));
    return getTransport().stopCanonicalSubagent(threadId, row.childThreadId);
  };
  const onBack = () => {
    clearDetail(threadId);
    window.requestAnimationFrame(() => {
      if (viewportRef.current) viewportRef.current.scrollTop = selection?.scrollTop ?? 0;
      if (selected) document.querySelector<HTMLElement>(`[data-subagent-id="${CSS.escape(selected.id)}"]`)?.focus();
    });
  };
  if (selected) {
    return selected.tier === "transcript" && selected.childThreadId
      ? <TranscriptDetail row={selected} childThreadId={selected.childThreadId} onBack={onBack} onStop={() => stopRow(selected)} onTerminal={refresh} />
      : <NarrativeDetailView key={selected.id} threadId={threadId} row={selected} revision={`${roster?.epoch}:${roster?.revision}`} onBack={onBack} />;
  }
  return <SubagentRosterList roster={roster} error={error} stopAll={stopAll} viewportRef={viewportRef} refresh={refresh}
    stopRow={stopRow} onSelect={(row, tab) => selectDetail(threadId, { id: row.id, originTab: tab, scrollTop: viewportRef.current?.scrollTop ?? 0 })} />;
}

function SubagentRosterList({ roster, error, stopAll, viewportRef, refresh, stopRow, onSelect }: {
  roster: SubagentRoster | undefined; error: boolean; stopAll: ReturnType<typeof useStopAllControl>;
  viewportRef: React.RefObject<HTMLDivElement | null>; refresh: () => Promise<void>;
  stopRow: (row: SubagentRosterEntry) => Promise<CanonicalSubagentStopResult>;
  onSelect: (row: SubagentRosterEntry, tab: "active" | "finished") => void;
}) {
  const rows = roster?.entries ?? [];
  const active = rows.filter((row) => row.status === "running");
  const done = rows.filter((row) => row.status !== "running");
  return <section ref={stopAll.panelRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
    {error && <div data-testid="subagents-error" role="alert" className="px-4 py-3">Couldn't load subagents <Button variant="ghost" onClick={() => void refresh()}>Retry</Button></div>}
    {!roster && !error && <p className="px-4 py-6 text-sm text-muted">Loading subagents…</p>}
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
      {roster && rows.length === 0 && <p data-testid="subagents-empty" className="px-4 py-6 text-sm text-muted">Sub-agents will appear here when this thread delegates work.</p>}
      {[{ label: "Running", rows: active, tab: "active" as const }, { label: "Done", rows: done, tab: "finished" as const }].map((group) => group.rows.length > 0 && <section key={group.tab} aria-label={group.label}>
        <div className="flex items-center gap-2 px-6 pb-1 pt-6">
          <h2 className="text-sm font-semibold text-ink">{group.label}</h2>
          <Badge variant="ghost" size="compact" className="px-0 font-mono font-normal text-muted">{group.rows.length}</Badge>
          {group.tab === "active" && active.filter((row) => row.canStop).length >= 2 && <Button ref={stopAll.triggerRef} variant="ghost" size="compact" onClick={stopAll.openStopAll}>Stop all</Button>}
        </div>
        {group.rows.map((row) => <RosterRow key={row.id} row={row}
          onSelect={() => onSelect(row, group.tab)}
          onStop={() => stopRow(row)} onTerminal={refresh} />)}
      </section>)}
    </ScrollArea>
    <StopAllConfirmationDialog open={stopAll.open} targets={stopAll.targets} statuses={stopAll.statuses} batchActive={stopAll.batchActive}
      triggerRef={stopAll.triggerRef} panelRef={stopAll.panelRef} cancelRef={stopAll.cancelRef} onOpenChange={stopAll.onOpenChange}
      onCancel={() => stopAll.onOpenChange(false, { cancel: () => undefined })} onConfirm={stopAll.confirm} />
  </section>;
}
