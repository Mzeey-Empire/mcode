import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, CircleX, Minus } from "lucide-react";
import type { ThreadStartup, ThreadStartupKind } from "@mcode/contracts/thread-startup";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { OriginFetchActions } from "./OriginFetchActions";
import { StartupSetupOutput } from "./StartupSetupOutput";
import { useStartupCancel, useStartupFetchDecision, useStartupSetupDecision, useStartupSetupView, type SetupDecisionAction } from "./useStartupActions";
import {
  placeholderTrailRows,
  latestStartedStep,
  startupDecision,
  startupHasLiveStep,
  startupTrailRows,
  startupTrailAnnouncement,
  type StartupSetupView,
  type StartupTrailRow,
  type TrailPhase,
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
  /**
   * Thread-scoped recovery controls for the action row. The trail renders the setup and fetch
   * decisions itself, since they act on the startup alone.
   */
  readonly actions?: ReactNode;
  readonly onOpenTerminal?: (terminalSessionId: string) => void;
  readonly onEditScript?: () => void;
}

const LABEL_CLASS: Record<TrailRowTone, string> = {
  done: "text-muted",
  live: "font-medium text-ink",
  pending: "text-muted",
  failed: "font-medium text-error",
  approval: "font-medium text-ink",
  skipped: "text-muted",
  cancelled: "font-medium text-muted",
};

function StatusMark({ tone }: { readonly tone: TrailRowTone }) {
  switch (tone) {
    case "done":
      return <Check size={12} className="text-muted" />;
    case "live":
      return <Spinner size={16} className="text-primary" />;
    case "pending":
      return <span className="size-1 rounded-full bg-muted" />;
    case "failed":
      return <CircleAlert size={14} className="text-error" />;
    case "approval":
      return <CircleAlert size={14} className="text-muted" />;
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

/** The whole script, since Run setup approves every line of it and not just the first. */
function approvalDetail(startup: ThreadStartup | undefined, pending: WorkspaceEnvironmentActionRun | undefined): string | undefined {
  const script = pending?.snapshot.script?.trim();
  return script ? `$ ${script}` : startup?.block?.message;
}

function detailText(startup: ThreadStartup | undefined, pending: WorkspaceEnvironmentActionRun | undefined): string | undefined {
  if (startupDecision(startup) === "setup-approval") return approvalDetail(startup, pending);
  const reason = startup?.block ?? startup?.error;
  return reason?.detail ?? reason?.message;
}

function StartupDetailLine({ startup, pending }: { readonly startup: ThreadStartup | undefined; readonly pending: WorkspaceEnvironmentActionRun | undefined }) {
  const detail = detailText(startup, pending);
  if (!detail) return null;
  return <p role="alert" data-testid="startup-detail" className="whitespace-pre-wrap break-words pb-2 pl-6 pt-1 font-mono text-caption text-muted">{detail}</p>;
}

/** Paper 04f text action: a compact ghost button set in ink at caption size. */
const TEXT_ACTION_CLASS = "px-2 text-caption text-ink";

/** While one decision is in flight its button shows loading and stays focusable; the others disable. */
function blocksOtherActions(pending: SetupDecisionAction | null): (action: SetupDecisionAction) => boolean {
  return (action) => pending !== null && pending !== action;
}

function SetupFailedActions({ threadId, view, outputOpen, onToggleOutput }: {
  readonly threadId: string;
  readonly view: StartupSetupView;
  readonly outputOpen: boolean;
  readonly onToggleOutput: () => void;
}) {
  const decision = useStartupSetupDecision(threadId, view.pending);
  const blocks = blocksOtherActions(decision.pending);
  return (
    <>
      <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} disabled={blocks("retry")} loading={decision.pending === "retry"} onClick={() => decision.run("retry")}>Retry setup</Button>
      <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} disabled={blocks("skip")} loading={decision.pending === "skip"} onClick={() => decision.run("skip")}>Skip setup</Button>
      <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} aria-expanded={outputOpen} onClick={onToggleOutput}>{outputOpen ? "Hide output" : "Show output"}</Button>
    </>
  );
}

function SetupApprovalActions({ threadId, view }: { readonly threadId: string; readonly view: StartupSetupView }) {
  const decision = useStartupSetupDecision(threadId, view.pending);
  const blocks = blocksOtherActions(decision.pending);
  return (
    <>
      <Button type="button" variant="default" size="compact" className="px-3 text-caption" disabled={blocks("approve") || !view.pending} loading={decision.pending === "approve"} onClick={() => decision.run("approve")}>Run setup</Button>
      <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} disabled={blocks("skip")} loading={decision.pending === "skip"} onClick={() => decision.run("skip")}>Skip setup</Button>
    </>
  );
}

/** A startup action that never exits (a dev server, a watcher) holds the first turn until the user skips it. */
function SetupRunningActions({ threadId, view }: { readonly threadId: string; readonly view: StartupSetupView }) {
  const decision = useStartupSetupDecision(threadId, view.pending);
  return (
    <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} loading={decision.pending === "skip"} onClick={() => decision.run("skip")}>Skip setup</Button>
  );
}

function runsSetup(startup: ThreadStartup | undefined): startup is ThreadStartup & { readonly threadId: string } {
  return startup?.state === "running" && startup.phase === "setup" && startup.threadId !== undefined;
}

function FetchFailedActions({ startup }: { readonly startup: ThreadStartup }) {
  const decision = useStartupFetchDecision(startup);
  return decision ? <OriginFetchActions decision={decision} /> : null;
}

/** The startup-scoped decision the trail offers itself, ahead of any thread-scoped host actions. */
function StartupDecisionActions({ startup, view, outputOpen, onToggleOutput }: {
  readonly startup: ThreadStartup;
  readonly view: StartupSetupView;
  readonly outputOpen: boolean;
  readonly onToggleOutput: () => void;
}) {
  const decision = startupDecision(startup);
  if (decision === "fetch-failed") return <FetchFailedActions startup={startup} />;
  if (!startup.threadId) return null;
  if (runsSetup(startup)) return <SetupRunningActions threadId={startup.threadId} view={view} />;
  if (decision === "setup-failed") return <SetupFailedActions threadId={startup.threadId} view={view} outputOpen={outputOpen} onToggleOutput={onToggleOutput} />;
  if (decision === "setup-approval") return <SetupApprovalActions threadId={startup.threadId} view={view} />;
  return null;
}

function offersOwnDecision(startup: ThreadStartup | undefined): startup is ThreadStartup {
  const decision = startupDecision(startup);
  if (decision === "fetch-failed" || runsSetup(startup)) return true;
  return (decision === "setup-failed" || decision === "setup-approval") && startup?.threadId !== undefined;
}

function TrailSteps({ startup, kind, view, outputOpen, onToggleOutput, onOpenTerminal, onEditScript, stopPhase, decision }: Pick<StartupStepsTrailProps, "startup" | "kind" | "onOpenTerminal" | "onEditScript"> & {
  readonly view: StartupSetupView;
  readonly outputOpen: boolean;
  readonly onToggleOutput: () => void;
  /** The step a stopped startup stopped at, which carries the decision under it. */
  readonly stopPhase: TrailPhase | undefined;
  readonly decision: ReactNode;
}) {
  const now = useLiveNow(startupHasLiveStep(startup));
  const rows = startup ? startupTrailRows(startup, { now, setupCommand: view.commands.at(-1) }) : placeholderTrailRows(kind);
  const { terminalSessionId } = view;
  const openTerminal = onOpenTerminal && terminalSessionId !== null ? () => onOpenTerminal(terminalSessionId) : undefined;
  const setupOutput = startup && outputOpen
    ? <StartupSetupOutput commands={view.commands} transcript={startup.transcript} since={startup.steps.find((step) => step.phase === "setup")?.startedAt} onOpenTerminal={openTerminal} onEditScript={onEditScript} />
    : null;
  return rows.map((row) => (
    <div key={row.phase} className="flex flex-col gap-0.5">
      <TrailRow row={row} expanded={outputOpen} onToggle={onToggleOutput} />
      {row.phase === "setup" && setupOutput ? <div className="pb-1.5 pl-6 pt-1">{setupOutput}</div> : null}
      {row.phase === stopPhase ? decision : null}
    </div>
  ));
}

function TrailActions({ startup, view, outputOpen, onToggleOutput, actions, onCancel }: {
  readonly startup: ThreadStartup | undefined;
  readonly view: StartupSetupView;
  readonly outputOpen: boolean;
  readonly onToggleOutput: () => void;
  readonly actions: ReactNode;
  readonly onCancel: (() => void) | undefined;
}) {
  const ownDecision = offersOwnDecision(startup) ? startup : undefined;
  if (!ownDecision && !actions && !onCancel) return null;
  // Paper indents the approval row to the label column and packs its filled button tighter.
  const approval = startupDecision(startup) === "setup-approval";
  return (
    <div data-testid="startup-actions" className={cn("flex flex-wrap items-center", approval ? "gap-1 pl-6" : "pl-4")}>
      {ownDecision ? <StartupDecisionActions startup={ownDecision} view={view} outputOpen={outputOpen} onToggleOutput={onToggleOutput} /> : null}
      {actions}
      {onCancel ? <Button type="button" variant="ghost" size="compact" className={TEXT_ACTION_CLASS} onClick={onCancel}>Cancel</Button> : null}
    </div>
  );
}

/** Paper sets a decision right under the step it stopped at, so pending steps stay below it. */
function decisionStopPhase(startup: ThreadStartup | undefined): TrailPhase | undefined {
  return startup && startupDecision(startup) ? latestStartedStep(startup)?.phase : undefined;
}

/**
 * Renders one thread startup as a quiet trail of steps under the first user message.
 *
 * A completed startup renders nothing.
 * A stopped startup shows the Paper 04f decision for its state, and none of them offers Cancel.
 */
export function StartupStepsTrail({ startup, startupId, kind, actions, onOpenTerminal, onEditScript }: StartupStepsTrailProps) {
  const view = useStartupSetupView(startup);
  const cancel = useStartupCancel(startup, startupId);
  const liveCancel = startup?.state === "blocked" ? undefined : cancel;
  const [outputOpen, setOutputOpen] = useState(false);
  const toggleOutput = () => setOutputOpen((open) => !open);
  const announcement = <p role="status" className="sr-only">{startupTrailAnnouncement(startup)}</p>;
  const stopPhase = decisionStopPhase(startup);
  const decision = (
    <>
      <StartupDetailLine startup={startup} pending={view.pending} />
      <TrailActions startup={startup} view={view} outputOpen={outputOpen} onToggleOutput={toggleOutput} actions={actions} onCancel={liveCancel} />
    </>
  );
  if (startup?.state === "completed") return null;
  return (
    <section aria-label="Thread startup" data-testid="startup-trail" className="flex flex-col gap-0.5">
      {announcement}
      <TrailSteps startup={startup} kind={kind} view={view} outputOpen={outputOpen} onToggleOutput={toggleOutput} onOpenTerminal={onOpenTerminal} onEditScript={onEditScript} stopPhase={stopPhase} decision={decision} />
      {stopPhase ? null : decision}
    </section>
  );
}
