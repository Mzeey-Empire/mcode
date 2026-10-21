import { useCallback, useId, useState } from "react";
import type { HandoffAuditMetadata, Message, ProviderSwitchMarker as ProviderSwitch } from "@mcode/contracts";
import { ExpandIcon } from "@/components/ui/icon-map";
import { ProviderIcon, providerLabel } from "@/components/ui/provider-icon";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";

type HandoffState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly meta: HandoffAuditMetadata; readonly history: string }
  | { readonly phase: "unavailable" };

// Read on first expand only: most markers are never opened, and the history can be large.
function useHandoffRecord(threadId: string, handoffId: string): { state: HandoffState | null; request: () => void } {
  const [state, setState] = useState<HandoffState | null>(null);
  const request = useCallback(() => {
    if (state !== null) return;
    setState({ phase: "loading" });
    getTransport().readHandoff(threadId, handoffId).then(
      (record) => setState(record ? { phase: "ready", meta: record.meta, history: record.history } : { phase: "unavailable" }),
      (error: unknown) => {
        console.warn("[provider-switch] handoff read failed", { threadId, handoffId, error });
        setState({ phase: "unavailable" });
      },
    );
  }, [state, threadId, handoffId]);
  return { state, request };
}

function HandoffDetails({ state }: { readonly state: HandoffState }) {
  if (state.phase === "loading") return <p className="text-xs text-muted">Loading handoff</p>;
  if (state.phase === "unavailable") return <p className="text-xs text-muted">Handoff record unavailable</p>;
  const { meta, history } = state;
  const covered = meta.coveredSequences.length;
  return (
    <div className="space-y-1.5">
      {meta.droppedOptions.map((dropped) => (
        <p key={dropped.option} className="text-xs text-muted">Dropped {dropped.option}: {dropped.reason}</p>
      ))}
      <p className="text-xs text-muted">Sent {covered} of {covered + meta.omittedSequences.length} messages</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-panel px-3 py-2 font-code text-xs text-ink">{history}</pre>
    </div>
  );
}

/**
 * Timeline marker for a send that moved the thread to another provider. The
 * handoff (the history the new provider received) is collapsed beneath it.
 */
export function ProviderSwitchMarker({ message, providerSwitch }: { readonly message: Message; readonly providerSwitch: ProviderSwitch }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { state: handoff, request: requestHandoff } = useHandoffRecord(message.thread_id, providerSwitch.handoffId);
  const label = `Switched from ${providerLabel(providerSwitch.fromProvider)} to ${providerLabel(providerSwitch.toProvider)}`;
  return (
    <div className="py-2" role="note" data-provider-switch={providerSwitch.handoffId}>
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <ProviderIcon provider={providerSwitch.fromProvider} size={12} />
          <span className="min-w-0 text-fade whitespace-nowrap">{label}</span>
          <ProviderIcon provider={providerSwitch.toProvider} size={12} />
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => {
              if (!expanded) requestHandoff();
              setExpanded(!expanded);
            }}
            className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded-sm text-xs text-muted outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus"
          >
            Handoff
            <ExpandIcon aria-hidden size={12} className={cn("transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
          </button>
        </div>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <div id={detailsId} hidden={!expanded} className="mt-2">
        {expanded && handoff && <HandoffDetails state={handoff} />}
      </div>
    </div>
  );
}
