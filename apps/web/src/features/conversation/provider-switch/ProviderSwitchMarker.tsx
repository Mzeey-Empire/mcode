import { useCallback, useId, useState } from "react";
import type {
  HandoffAuditMetadata,
  HandoffTranscriptMessage,
  Message,
  ProviderSwitchMarker as ProviderSwitch,
} from "@mcode/contracts";
import { ExpandIcon } from "@/components/ui/icon-map";
import { ProviderIcon, providerLabel } from "@/components/ui/provider-icon";
import { cn } from "@/lib/utils";
import { getTransport } from "@/transport";

type HandoffState =
  | { readonly phase: "loading" }
  | {
    readonly phase: "ready";
    readonly meta: HandoffAuditMetadata;
    readonly history: string;
    readonly messages: readonly HandoffTranscriptMessage[];
  }
  | { readonly phase: "unavailable" };

const TOGGLE_CLASS = "inline-flex shrink-0 items-center gap-0.5 rounded-sm text-xs text-muted outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus";

// Read on first expand only: most markers are never opened, and the history can be large.
function useHandoffRecord(threadId: string, handoffId: string): { state: HandoffState | null; request: () => void } {
  const [state, setState] = useState<HandoffState | null>(null);
  const request = useCallback(() => {
    if (state !== null) return;
    setState({ phase: "loading" });
    getTransport().readHandoff(threadId, handoffId).then(
      (record) => setState(record ? { phase: "ready", ...record } : { phase: "unavailable" }),
      (error: unknown) => {
        console.warn("[provider-switch] handoff read failed", { threadId, handoffId, error });
        setState({ phase: "unavailable" });
      },
    );
  }, [state, threadId, handoffId]);
  return { state, request };
}

function Disclosure({ label, expanded, onToggle, controls }: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly controls: string;
}) {
  return (
    <button type="button" aria-expanded={expanded} aria-controls={controls} onClick={onToggle} className={TOGGLE_CLASS}>
      {label}
      <ExpandIcon aria-hidden size={12} className={cn("transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
    </button>
  );
}

function RawHistory({ history }: { readonly history: string }) {
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-panel px-3 py-2 font-code text-xs text-ink">{history}</pre>;
}

function speakerLabel(message: HandoffTranscriptMessage): string {
  if (message.role === "user") return "You";
  return message.provider ? providerLabel(message.provider) : "Assistant";
}

function Transcript({ messages }: { readonly messages: readonly HandoffTranscriptMessage[] }) {
  return (
    <ol className="max-h-72 space-y-2 overflow-auto rounded-md border border-border px-3 py-2">
      {messages.map((message, index) => (
        <li key={index} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 text-xs">
          <span className="text-muted">{speakerLabel(message)}</span>
          <p className="whitespace-pre-wrap break-words text-ink">{message.text}</p>
        </li>
      ))}
    </ol>
  );
}

function HandoffDetails({ state }: { readonly state: HandoffState }) {
  const [rawOpen, setRawOpen] = useState(false);
  const rawId = useId();
  if (state.phase === "loading") return <p className="text-xs text-muted">Loading handoff</p>;
  if (state.phase === "unavailable") return <p className="text-xs text-muted">Handoff record unavailable</p>;
  const { meta, history, messages } = state;
  // A history stored without item boundaries cannot be split into messages, so only the raw text is honest.
  if (messages.length === 0) return <RawHistory history={history} />;
  const omitted = meta.omittedSequences.length;
  return (
    <div className="space-y-1.5">
      <Transcript messages={messages} />
      {omitted > 0 && <p className="text-xs text-muted">{omitted} {omitted === 1 ? "message" : "messages"} left out to fit</p>}
      <p className="text-xs text-muted">Not carried over: reasoning, tool output, attachments</p>
      {meta.droppedOptions.map((dropped) => (
        <p key={dropped.option} className="text-xs text-muted">Dropped {dropped.option}: {dropped.reason}</p>
      ))}
      <Disclosure label="Raw prompt" expanded={rawOpen} onToggle={() => setRawOpen(!rawOpen)} controls={rawId} />
      <div id={rawId} hidden={!rawOpen}>{rawOpen && <RawHistory history={history} />}</div>
    </div>
  );
}

/**
 * Timeline marker for a send that moved the thread to another provider. What
 * the new provider received is collapsed beneath it.
 */
export function ProviderSwitchMarker({ message, providerSwitch }: { readonly message: Message; readonly providerSwitch: ProviderSwitch }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { state: handoff, request: requestHandoff } = useHandoffRecord(message.thread_id, providerSwitch.handoffId);
  const from = providerLabel(providerSwitch.fromProvider);
  const to = providerLabel(providerSwitch.toProvider);
  return (
    <div className="py-2" role="note" aria-label={`Switched from ${from} to ${to}`} data-provider-switch={providerSwitch.handoffId}>
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted">
          <ProviderIcon provider={providerSwitch.fromProvider} size={12} />
          <span>{from}</span>
          <span aria-hidden="true">→</span>
          <ProviderIcon provider={providerSwitch.toProvider} size={12} />
          <span className="font-medium text-ink">{to}</span>
          <span aria-hidden="true">·</span>
          <Disclosure
            label={`What ${to} saw`}
            expanded={expanded}
            controls={detailsId}
            onToggle={() => {
              if (!expanded) requestHandoff();
              setExpanded(!expanded);
            }}
          />
        </div>
        <div className="h-px flex-1 bg-border" aria-hidden="true" />
      </div>
      <div id={detailsId} hidden={!expanded} className="mt-2">
        {expanded && handoff && <HandoffDetails state={handoff} />}
      </div>
    </div>
  );
}
