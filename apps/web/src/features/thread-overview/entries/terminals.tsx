import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { Button, IconButton } from "@/components/ui/button";
import { ActionIcon } from "@/features/projects/actions/ActionIcon";
import { shellActionIconId } from "@/features/projects/actions/action-icons";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { terminalTabLabels } from "@/features/terminal/surfaces/terminalTabs";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon } from "@/features/thread-overview/overview-row";
import type { OverviewSubject } from "@/features/thread-overview/overview-subject";
import { openRightPanelTab } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores/toastStore";
import { getTransport, type Thread } from "@/transport";

const COLLAPSED_ROW_COUNT = 3;
const EMPTY_TERMINALS: readonly TerminalInstance[] = [];
const EMPTY_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

interface TerminalRow {
  readonly id: string;
  readonly name: string;
  readonly icon: { readonly iconId: string | undefined; readonly command: string };
  readonly kind: "shell" | "action";
  /** The port an action announced, or null for a shell and for an action that never announced one. */
  readonly port: number | null;
}

/** The row for a terminal that is doing something, or null when it is idle, exited or a finished action. */
function liveRow(
  terminal: TerminalInstance,
  name: string,
  runs: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
): TerminalRow | null {
  if ((terminal.state ?? "running") !== "running") return null;
  if (terminal.kind !== "action") {
    return { id: terminal.id, name, icon: { iconId: shellActionIconId(terminal.label), command: "" }, kind: "shell", port: null };
  }
  const run = runs[terminal.actionId ?? ""];
  if (run?.status !== "running") return null;
  const port = run.port?.runId === run.runId ? run.port.port : null;
  return { id: terminal.id, name, icon: { iconId: undefined, command: run.snapshot.script ?? "" }, kind: "action", port };
}

/**
 * The terminals doing something right now, newest first. A shell counts while its process
 * lives. An action counts only while its run is running: once the command ends, the record
 * stays behind as an idle shell the Terminal tab still lists.
 */
function liveTerminalRows(
  terminals: readonly TerminalInstance[],
  runs: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
): readonly TerminalRow[] {
  const labels = terminalTabLabels(terminals, runs);
  const rows: { readonly row: TerminalRow; readonly createdAt: string }[] = [];
  for (const terminal of terminals) {
    const row = liveRow(terminal, labels.get(terminal.id) ?? terminal.label, runs);
    if (row) rows.push({ row, createdAt: terminal.createdAt ?? "" });
  }
  // The store lists terminals in creation order, so reversing first keeps that order for records without a timestamp.
  return rows
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ row }) => row);
}

function rowMeta(row: TerminalRow): ReactNode {
  if (row.port !== null) return <span className="font-mono">:{row.port}</span>;
  return row.kind === "shell" ? "Shell" : null;
}

function stopTerminal(ptyId: string): void {
  getTransport().terminalKill(ptyId).catch(() => {
    useToastStore.getState().show({ kind: "failed", title: "Couldn't stop the terminal" });
  });
}

function TerminalRowItem({ row, onOpen }: { readonly row: TerminalRow; readonly onOpen: (ptyId: string) => void }) {
  return (
    <div
      data-testid="thread-overview-terminal"
      className="group/terminal relative rounded-control hover:bg-hover focus-within:bg-hover"
    >
      <Button
        variant="ghost"
        size="compact"
        type="button"
        aria-label={row.name}
        onClick={() => onOpen(row.id)}
        className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-start gap-2 hover:bg-transparent")}
      >
        <OverviewRowIcon>
          <ActionIcon iconId={row.icon.iconId} command={row.icon.command} size={16} />
        </OverviewRowIcon>
        <span className="min-w-0 flex-1 text-fade text-ink">{row.name}</span>
        <span className="shrink-0 text-xs/4 text-muted group-focus-within/terminal:invisible group-hover/terminal:invisible">
          {rowMeta(row)}
        </span>
      </Button>
      <IconButton
        shape="round"
        size="inline-sm"
        aria-label={`Stop ${row.name}`}
        onClick={() => stopTerminal(row.id)}
        className="absolute top-1/2 right-3 hidden -translate-y-1/2 group-focus-within/terminal:flex group-hover/terminal:flex"
      >
        <span aria-hidden className="size-2 rounded-xs bg-ink" />
      </IconButton>
    </div>
  );
}

function TerminalsSection({ thread }: { readonly thread: Thread }) {
  const terminals = useTerminalStore((state) => state.terminals[thread.id] ?? EMPTY_TERMINALS);
  const runs = useProjectActionStore((state) => state.runsByThread[thread.id] ?? EMPTY_RUNS);
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => liveTerminalRows(terminals, runs), [terminals, runs]);
  if (rows.length === 0) return null;
  const hidden = rows.length - COLLAPSED_ROW_COUNT;
  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROW_COUNT);
  const openTerminal = (ptyId: string) => {
    openRightPanelTab(thread.workspace_id, thread.id, "terminal");
    useTerminalStore.getState().setActiveTerminal(thread.id, ptyId);
  };
  return (
    <section aria-label="Terminals" className="flex flex-col gap-1">
      <h3 className="flex h-6 items-center px-3 text-xs/4 font-medium text-muted">Terminals</h3>
      {visible.map((row) => <TerminalRowItem key={row.id} row={row} onOpen={openTerminal} />)}
      {hidden > 0 ? (
        <Button
          variant="ghost"
          size="compact"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={cn(OVERVIEW_ROW_CLASS, "cursor-pointer justify-start text-muted")}
        >
          <OverviewRowIcon>{expanded ? <ChevronUp /> : <ChevronDown />}</OverviewRowIcon>
          {expanded ? "Show less" : `${hidden} more`}
        </Button>
      ) : null}
    </section>
  );
}

/** The terminals running in this thread, with a Stop on each row. Empty when nothing runs. */
export function OverviewTerminalsSection({ subject }: { readonly subject: OverviewSubject }) {
  return subject.kind === "thread" ? <TerminalsSection thread={subject.thread} /> : null;
}
