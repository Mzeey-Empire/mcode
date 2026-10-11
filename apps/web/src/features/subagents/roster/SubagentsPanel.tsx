import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import type { SubagentRosterEntry, CanonicalSubagentStopResult } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { PanelHeaderSlot, PanelTitlePill } from "@/components/panels/shell/PanelHeader";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { getTransport } from "@/transport";
import { getConversationResidency, MessageList, SubagentProviderScope } from "@/features/conversation";
import { SubagentStopControl } from "../lifecycle/SubagentStopControl";
import { useClearSubagentDetail, useSelectSubagentDetail, useSubagentDetailSelection } from "../state";
import { useSubagentRoster, useSubagentRosterStore } from "../state/subagentRosterStore";
import { subagentStatusLabel } from "../subagent-status";
import { NarrativeDetailView } from "../detail/NarrativeDetailView";
import { openSubagentDetail, openSubagentsRoster } from "../detail/open-subagent-detail";
import { SubagentList } from "../list/SubagentList";

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
    <PanelHeaderSlot slot="leading">
      <Button type="button" variant="ghost" size="icon-compact" onClick={onBack} aria-label="Back to subagents" className="shrink-0"><ArrowLeft size={15} aria-hidden /></Button>
      <PanelTitlePill headingLevel={2} icon={<ProviderIcon provider={row.provider} size={16} />}>{row.title}</PanelTitlePill>
    </PanelHeaderSlot>
    <span role="status" className="sr-only">{subagentStatusLabel(row.status)}</span>
    <div className="min-h-0 flex-1"><MessageList displayThreadId={childThreadId} onSubagentSelect={openSubagentDetail} onOpenSubagents={openSubagentsRoster} /></div>
    {row.status === "running" && row.canStop && <div data-testid="subagent-detail-actions" className="flex shrink-0 justify-end border-t border-border/40 px-4 py-2">
      <SubagentStopControl active canStop label={row.title} onStop={onStop} onTerminal={onTerminal} />
    </div>}
  </section>;
}

/** Render the shared server roster as the Subagents list, or the selected child detail. */
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
  const selected = roster?.entries.find((entry) => entry.id === selection?.id);
  const stopRow = (row: SubagentRosterEntry) => {
    if (!row.childThreadId) return Promise.reject(new Error("Subagent cannot be stopped independently"));
    return getTransport().stopCanonicalSubagent(threadId, row.childThreadId);
  };
  const stopListRow = async (row: SubagentRosterEntry) => {
    const result = await stopRow(row);
    if (result.status === "interrupted" || result.status === "already-terminal") await refresh();
    return result;
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
  return <SubagentList roster={roster} error={error} viewportRef={viewportRef} onRetry={() => void refresh()} onStop={stopListRow}
    onSelect={(row) => selectDetail(threadId, { id: row.id, scrollTop: viewportRef.current?.scrollTop ?? 0 })} />;
}
