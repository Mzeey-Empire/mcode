import { useRef, useState } from "react";
import { Check, Layers } from "lucide-react";
import { isLiveSubagentStatus, type SubagentRoster, type SubagentRosterEntry } from "@mcode/contracts/models/subagent-roster";
import { type CanonicalSubagentStopResult } from "@mcode/contracts/models/canonical-subagent-roster";
import { Button, IconButton } from "@/components/ui/button";
import { PanelHeaderSlot, PanelTitlePill } from "@/components/panels/shell/PanelHeader";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores/toastStore";
import { subagentStatusLabel } from "../subagent-status";
import { elapsed, useNow } from "../live-duration";
import { subagentKind } from "../subagent-kind";

/** Props for {@link SubagentList}. */
export interface SubagentListProps {
  readonly roster: SubagentRoster | undefined;
  readonly error: boolean;
  readonly viewportRef: React.RefObject<HTMLDivElement | null>;
  readonly onRetry: () => void;
  readonly onSelect: (row: SubagentRosterEntry) => void;
  readonly onStop: (row: SubagentRosterEntry) => Promise<CanonicalSubagentStopResult>;
}

function byNewestStart(a: SubagentRosterEntry, b: SubagentRosterEntry): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

/** Running rows first, then finished rows, each newest first. */
function partitionRows(entries: readonly SubagentRosterEntry[]) {
  const running = entries.filter((row) => isLiveSubagentStatus(row.status)).sort(byNewestStart);
  const finished = entries.filter((row) => !isLiveSubagentStatus(row.status)).sort(byNewestStart);
  return { running, finished };
}

function rowMeta(row: SubagentRosterEntry): string {
  return [subagentKind(row), row.stepCount > 0 ? `${row.stepCount} steps` : null].filter(Boolean).join(" · ");
}

function StatusTrail({ row, now }: { readonly row: SubagentRosterEntry; readonly now: number }) {
  const duration = elapsed(row, now);
  const time = duration && <span className="font-mono text-xs">{duration}</span>;
  switch (row.status) {
    case "running":
      return <span className="flex items-center gap-1.5 text-ink"><span aria-hidden className="size-[7px] rounded-full bg-success" />{time}</span>;
    case "waiting":
      return <span className="flex items-center gap-1.5 text-ink">
        <span aria-hidden className="size-[7px] rounded-full bg-warning" />
        <span className="text-xs font-medium">{subagentStatusLabel(row.status)}</span>{time}
      </span>;
    case "done":
      return <span className="flex items-center gap-1.5 text-muted"><Check size={12} aria-hidden />{time}</span>;
    case "failed":
      return <span className="flex items-center gap-1.5 text-muted">
        <span aria-hidden className="size-[7px] rounded-full bg-error" />
        <span className="text-xs font-medium text-error">{subagentStatusLabel(row.status)}</span>{time}
      </span>;
    case "stopped":
      return <span className="flex items-center gap-1.5 text-muted"><span className="text-xs font-medium">{subagentStatusLabel(row.status)}</span>{time}</span>;
  }
}

function RowStop({ row, onStop, onStopped }: {
  readonly row: SubagentRosterEntry; readonly onStop: SubagentListProps["onStop"]; readonly onStopped: () => void;
}) {
  const [pending, setPending] = useState(false);
  const stop = async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await onStop(row);
      if (result.status === "interrupted" || result.status === "already-terminal") onStopped();
      else {
        useToastStore.getState().show({ kind: "failed", title: `Couldn't stop ${row.title}`, meta: result.message ?? undefined });
      }
    } catch {
      useToastStore.getState().show({ kind: "failed", title: `Couldn't stop ${row.title}` });
    } finally {
      setPending(false);
    }
  };
  return (
    <IconButton shape="round" size="inline" aria-label={`Stop ${row.title}`} disabled={pending} aria-busy={pending}
      onClick={() => void stop()}
      className={cn("hidden group-focus-within/row:inline-flex group-hover/row:inline-flex [@media(hover:none)]:inline-flex", pending && "inline-flex")}>
      <span aria-hidden className="size-2 rounded-[2px] bg-ink" />
    </IconButton>
  );
}

function SubagentListRow({ row, now, onSelect, onStop }: {
  readonly row: SubagentRosterEntry; readonly now: number;
  readonly onSelect: SubagentListProps["onSelect"]; readonly onStop: SubagentListProps["onStop"];
}) {
  const running = isLiveSubagentStatus(row.status);
  const stoppable = running && row.canStop && row.childThreadId !== null;
  const meta = rowMeta(row);
  const selectRef = useRef<HTMLButtonElement | null>(null);
  return (
    <li data-testid={running ? "subagent-active-row" : "subagent-finished-row"}
      className={cn("group/row flex h-13 min-w-0 items-center gap-1.5 rounded-lg transition-colors duration-(--duration-fast) hover:bg-hover", stoppable && "hover:pr-1.5 focus-within:pr-1.5 [@media(hover:none)]:pr-1.5")}>
      <Button ref={selectRef} type="button" variant="ghost" onClick={() => onSelect(row)} data-subagent-id={row.id}
        aria-label={`Open ${row.title} details, ${subagentStatusLabel(row.status)}`}
        className="h-full min-w-0 flex-1 justify-start gap-2.5 rounded-lg px-2.5 text-left hover:bg-transparent focus-visible:outline-offset-[-2px]">
        <ProviderIcon provider={row.provider} size={16} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-fade text-sm font-medium text-ink">{row.title}</span>
          {meta && <span className="text-fade text-xs text-muted">{meta}</span>}
        </span>
        <StatusTrail row={row} now={now} />
      </Button>
      {stoppable && <RowStop row={row} onStop={onStop} onStopped={() => selectRef.current?.focus()} />}
    </li>
  );
}

/** The Subagents panel list: running children, a divider, then finished children. */
export function SubagentList({ roster, error, viewportRef, onRetry, onSelect, onStop }: SubagentListProps) {
  const { running, finished } = partitionRows(roster?.entries ?? []);
  const now = useNow(running.length > 0);
  const renderRow = (row: SubagentRosterEntry) => <SubagentListRow key={row.id} row={row} now={now} onSelect={onSelect} onStop={onStop} />;
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Subagents">
      <PanelHeaderSlot slot="leading"><PanelTitlePill icon={<Layers size={14} aria-hidden />}>Subagents</PanelTitlePill></PanelHeaderSlot>
      {error && <div data-testid="subagents-error" role="alert" className="flex items-center gap-2 px-4 py-3 text-sm text-ink">
        Couldn't load subagents <Button variant="ghost" size="compact" onClick={onRetry}>Retry</Button>
      </div>}
      {!roster && !error && <p className="px-4 py-6 text-sm text-muted">Loading subagents…</p>}
      <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
        {roster && running.length + finished.length === 0 && <p data-testid="subagents-empty" className="px-4 py-6 text-sm text-muted">
          Subagents appear here when this thread delegates work.
        </p>}
        <ul className="flex flex-col gap-0.5 px-2 pt-1 pb-2">
          {/* One keyed array keeps a row mounted, and its focus, when it moves from running to finished. */}
          {[
            ...running.map(renderRow),
            running.length > 0 && finished.length > 0 && <li key="divider" aria-hidden className="px-2.5 py-1.5"><div className="h-px bg-border" /></li>,
            ...finished.map(renderRow),
          ]}
        </ul>
      </ScrollArea>
    </section>
  );
}
