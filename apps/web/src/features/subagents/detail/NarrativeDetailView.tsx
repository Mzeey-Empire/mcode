import { useEffect, useState } from "react";
import { ArrowLeft, CircleCheck, CircleX } from "lucide-react";
import type { SubagentRosterEntry, SubagentDetail } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { Spinner } from "@/components/ui/spinner";
import { getTransport } from "@/transport";
import { subagentStatusLabel } from "../subagent-status";

function ActivityRow({ step }: { step: SubagentDetail["steps"][number] }) {
  return <li data-testid="narrative-subagent-activity" className="flex min-w-0 items-baseline gap-2 px-4 py-1">
    {step.status === "failed" ? <CircleX size={13} aria-hidden className="text-destructive" />
      : step.status === "running" ? <Spinner size={12} className="text-muted" />
      : <CircleCheck size={13} aria-hidden className="text-muted" />}
    <span className="shrink-0 text-xs font-medium text-ink/80">{step.toolName}</span>
    {step.label !== step.toolName && <span className="min-w-0 flex-1 text-fade text-xs text-muted">{step.label}</span>}
  </li>;
}

/** Render server-owned steps and summary without constructing a second roster. */
export function NarrativeDetailView({ threadId, row, revision, onBack }: {
  threadId: string; row: SubagentRosterEntry; revision: string; onBack: () => void;
}) {
  const [detail, setDetail] = useState<SubagentDetail | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (row.tier !== "steps") return;
    let cancelled = false;
    void getTransport().loadSubagentDetail(threadId, row.id).then((loaded) => {
      if (!cancelled) { setDetail(loaded); setError(false); }
    }, () => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [threadId, row.id, row.tier, revision, retry]);
  const configuration = [row.subagentType, row.model].filter(Boolean).join(" · ");
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={`${row.title} subagent details`}>
    <header className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
      <Button type="button" variant="ghost" size="icon-compact" onClick={onBack} aria-label="Back to subagents" className="shrink-0"><ArrowLeft size={15} aria-hidden /></Button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ProviderIcon provider={row.provider} size={20} />
        <h2 className="min-w-0 flex-1 text-fade text-sm font-semibold">{row.title}</h2>
        <span role="status" className="sr-only">{subagentStatusLabel(row.status)}</span>
        {configuration && <span className="shrink-0 font-mono text-xs text-muted">{configuration}</span>}
      </div>
    </header>
    <ScrollArea className="min-h-0 flex-1">
      {error && <p role="alert">Couldn't load subagent activity <Button onClick={() => setRetry((value) => value + 1)}>Retry</Button></p>}
      {detail && <DetailActivity detail={detail} running={row.status === "running"} />}
      {row.tier === "meta" && row.prompt && <p className="whitespace-pre-wrap px-4 py-3 text-xs text-ink/85">{row.prompt}</p>}
    </ScrollArea>
  </section>;
}

function DetailActivity({ detail, running }: { detail: SubagentDetail; running: boolean }) {
  return <>
    {detail.summary && <p className="whitespace-pre-wrap px-4 py-3 text-xs text-ink/85">{detail.summary}</p>}
    {detail.steps.length > 0 && <ul className="py-2" aria-label="Subagent activity">{detail.steps.map((step) => <ActivityRow key={step.toolCallId} step={step} />)}</ul>}
    {detail.totalSteps === 0 && !running && <p className="px-4 py-3 text-xs text-muted">No steps were recorded.</p>}
    {detail.totalSteps > detail.steps.length && <p className="px-4 pb-3 text-xs text-muted">Earlier activity is truncated.</p>}
  </>;
}
