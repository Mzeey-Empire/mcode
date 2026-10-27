import { useRef } from "react";
import type { SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { getTransport } from "@/transport";
import { SubagentProviderScope } from "@/features/conversation";
import { useSubagentRoster, useSubagentRosterStore } from "../state/subagentRosterStore";
import { openSubagentDetail } from "../detail/open-subagent-detail";
import { SubagentList } from "../list/SubagentList";

/** Render the shared server roster as the Subagents list. Each row opens its own rail tab. */
export function SubagentsPanel({ threadId }: { readonly threadId: string }) {
  return <SubagentProviderScope threadId={threadId}><SubagentsPanelContent key={threadId} threadId={threadId} /></SubagentProviderScope>;
}

function SubagentsPanelContent({ threadId }: { readonly threadId: string }) {
  const roster = useSubagentRoster(threadId);
  const error = useSubagentRosterStore((state) => state.errors.has(threadId));
  const refresh = () => useSubagentRosterStore.getState().refresh(threadId);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stopRow = async (row: SubagentRosterEntry) => {
    if (!row.childThreadId) throw new Error("Subagent cannot be stopped independently");
    const result = await getTransport().stopCanonicalSubagent(threadId, row.childThreadId);
    if (result.status === "interrupted" || result.status === "already-terminal") await refresh();
    return result;
  };
  return <SubagentList roster={roster} error={error} viewportRef={viewportRef} onRetry={() => void refresh()} onStop={stopRow}
    onSelect={(row) => openSubagentDetail(row.id)} />;
}
