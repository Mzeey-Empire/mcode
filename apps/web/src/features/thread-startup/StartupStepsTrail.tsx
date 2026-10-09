import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleX, LoaderCircle, Minus } from "lucide-react";
import type { ThreadStartup, ThreadStartupKind } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { StartupSetupOutput } from "./StartupSetupOutput";
import { useStartupCancel, useStartupSetupScript } from "./useStartupActions";
import {
  placeholderTrailRows,
  setupCommandLine,
  startupHasLiveStep,
  startupTrailRows,
  startupTrailAnnouncement,
  startupTrailSummary,
  type StartupTrailRow,
  type TrailRowTone,
} from "./startup-step-copy";

/** Props for the startup steps trail under the first user message. */
export interface StartupStepsTrailProps {
  /** Server-authoritative record; absent until the server creates it. */
  readonly startup?: ThreadStartup;
  /** Startup identity used for cancellation before the record arrives. */
  readonly startupId?: string;
  /** Kind used to draw pending placeholder rows before the record arrives. */
  readonly kind: ThreadStartupKind;
  /** Recovery and decision controls rendered in the action row. */
  readonly actions?: ReactNode;
  readonly onOpenTerminal?: () => void;
  readonly onEditScript?: () => void;
}

const LABEL_CLASS: Record<TrailRowTone, string> = {
  done: "text-muted",
  live: "font-medium text-ink",
  pending: "text-muted",
  failed: "font-medium text-error",
  skipped: "text-muted",
  cancelled: "font-medium text-ink",
};

function StatusMark({ tone }: { readonly tone: TrailRowTone }) {
  switch (tone) {
    case "done":
      return <Check size={12} className="text-muted" />;
    case "live":
      return <LoaderCircle size={14} className="text-primary animate-spin motion-reduce:animate-none" />;
    case "pending":
      return <span className="size-1 rounded-full bg-muted" />;
    case "failed":
      return <CircleAlert size={14} className="text-error" />;
    case "skipped":
      return <Minus size={12} className="text-muted" />;
    case "cancelled":
      return <CircleX size={14} className="text-muted" />;
  }
}

function MarkSlot({ children }: { readonly children: ReactNode }) {
  return <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">{children}</span>;
}

const META_CLASS = "text-fade min-w-0 font-mono text-caption text-muted";

/** A mono meta segment; a shortened argument reveals its full value, such as the worktree path, on hover. */
function MetaText({ children, fullValue }: { readonly children: ReactNode; readonly fullValue?: string }) {
  if (!fullValue) return <span className={META_CLASS}>{children}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={META_CLASS}>{children}</span>} />
      <TooltipContent side="top" className="font-mono text-caption">{fullValue}</TooltipContent>
    </Tooltip>
  );
}

function TrailRow({ row, expanded, onToggle }: {
  readonly row: StartupTrailRow;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div data-testid={`startup-step-${row.phase}`} data-tone={row.tone} className={cn("flex h-6 items-center gap-2 text-caption", row.tone === "pending" && "opacity-50")}>
      <MarkSlot><StatusMark tone={row.tone} /></MarkSlot>
      <span className={cn("shrink-0", LABEL_CLASS[row.tone])}>{row.label}</span>
      {row.meta.map((part, index) => <MetaText key={index} fullValue={index === 0 ? row.title : undefined}>{part}</MetaText>)}
      {row.expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide setup output" : "Show setup output"}
          onClick={onToggle}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted hover:text-ink"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      ) : null}
    </div>
  );
}

function StartedRow({ startup, setupCommand, expanded, onToggle }: {
  readonly startup: ThreadStartup;
  readonly setupCommand: string | undefined;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const summary = startupTrailSummary(startup, setupCommand);
  return (
    <button
      type="button"
      data-testid="startup-started-row"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex h-6 max-w-full items-center gap-2 text-left text-caption text-muted hover:text-ink"
    >
      <MarkSlot>{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</MarkSlot>
      <span className="shrink-0">Started in</span>
      <span className="shrink-0 font-mono">{summary.duration}</span>
      {summary.parts.length > 0 ? <span className="text-fade min-w-0 font-mono">· {summary.parts.join(" · ")}</span> : null}
    </button>
  );
}

/** Ticks once a second only while a step is live, so idle trails hold no timer. */
function useLiveNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [live]);
  return now;
}

function StartupDetailLine({ startup }: { readonly startup: ThreadStartup | undefined }) {
  const reason = startup?.block ?? startup?.error;
  const detail = reason?.detail ?? reason?.message;
  if (!detail) return null;
  return <p role="alert" data-testid="startup-detail" className="whitespace-pre-wrap break-words pb-2 pl-6 pt-1 font-mono text-caption text-muted">{detail}</p>;
}

function TrailActions({ actions, onCancel }: { readonly actions: ReactNode; readonly onCancel?: () => void }) {
  if (!actions && !onCancel) return null;
  return (
    <div data-testid="startup-actions" className="flex flex-wrap items-center pl-4">
      {actions}
      {onCancel ? <Button type="button" variant="ghost" size="compact" className="px-2 text-caption text-ink" onClick={onCancel}>Cancel</Button> : null}
    </div>
  );
}

function TrailSteps({ startup, kind, setupScript, onOpenTerminal, onEditScript }: Pick<StartupStepsTrailProps, "startup" | "kind" | "onOpenTerminal" | "onEditScript"> & {
  readonly setupScript: string | undefined;
}) {
  const [outputOpen, setOutputOpen] = useState(false);
  const now = useLiveNow(startupHasLiveStep(startup));
  const rows = startup ? startupTrailRows(startup, { now, setupCommand: setupCommandLine(setupScript) }) : placeholderTrailRows(kind);
  const setupOutput = startup && outputOpen
    ? <StartupSetupOutput script={setupScript} transcript={startup.transcript} onOpenTerminal={onOpenTerminal} onEditScript={onEditScript} />
    : null;
  return rows.map((row) => (
    <div key={row.phase} className="flex flex-col gap-0.5">
      <TrailRow row={row} expanded={outputOpen} onToggle={() => setOutputOpen((open) => !open)} />
      {row.expandable && setupOutput ? <div className="pb-1.5 pl-6 pt-1">{setupOutput}</div> : null}
    </div>
  ));
}

/**
 * Renders one thread startup as a quiet trail of steps under the first user message.
 *
 * A completed startup collapses to a single "Started in" row that expands back to the steps.
 */
export function StartupStepsTrail({ startup, startupId, kind, actions, onOpenTerminal, onEditScript }: StartupStepsTrailProps) {
  const setupScript = useStartupSetupScript(startup);
  const onCancel = useStartupCancel(startup, startupId);
  const [stepsOpen, setStepsOpen] = useState(false);
  const completedStartup = startup?.state === "completed" ? startup : undefined;
  const startedRow = completedStartup
    ? <StartedRow startup={completedStartup} setupCommand={setupCommandLine(setupScript)} expanded={stepsOpen} onToggle={() => setStepsOpen((open) => !open)} />
    : null;
  const announcement = <p role="status" className="sr-only">{startupTrailAnnouncement(startup)}</p>;
  if (completedStartup && !stepsOpen) return <section aria-label="Thread startup" data-testid="startup-trail">{announcement}{startedRow}</section>;
  return (
    <section aria-label="Thread startup" aria-busy={startup ? startupHasLiveStep(startup) : true} data-testid="startup-trail" className="flex flex-col gap-0.5">
      {announcement}
      {startedRow}
      <TrailSteps startup={startup} kind={kind} setupScript={setupScript} onOpenTerminal={onOpenTerminal} onEditScript={onEditScript} />
      <StartupDetailLine startup={startup} />
      <TrailActions actions={actions} onCancel={onCancel} />
    </section>
  );
}
