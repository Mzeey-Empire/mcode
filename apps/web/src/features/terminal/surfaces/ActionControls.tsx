import { useEffect, useState } from "react";
import { Ellipsis, Play, RotateCcw, Square } from "lucide-react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { IconButton } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { useDiffStore } from "@/stores/diffStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { applyActionRun } from "../state/applyActionRun";
import type { TerminalInstance } from "../state/terminalStore";
import { ActionPortPill } from "./ActionPortPill";
import { commandHeadline } from "./terminalTabs";

type ActionCommand = "stop" | "restart";

interface ActionControlsProps {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly terminal: TerminalInstance;
  readonly onClose: (ptyId: string) => void;
}

function showFailure(title: string, error: unknown): void {
  useToastStore.getState().show({ kind: "failed", title, meta: error instanceof Error ? error.message : String(error) });
}

/**
 * Reconnect can restore a terminal before any action menu hydrates its run,
 * so these controls must be able to hydrate independently.
 */
function useActionRun(threadId: string, actionId: string): WorkspaceEnvironmentActionRun | null {
  const run = useProjectActionStore((state) => state.runsByThread[threadId]?.[actionId] ?? null);
  useEffect(() => {
    if (run) return;
    let current = true;
    void getTransport()
      .getWorkspaceActionRun(threadId, actionId)
      .then((hydrated) => {
        if (current && hydrated) applyActionRun(hydrated, { focus: false });
      })
      .catch((error: unknown) => {
        if (current) showFailure("Couldn't load the action run", error);
      });
    return () => {
      current = false;
    };
  }, [actionId, run, threadId]);
  return run;
}

function CommandPill({ run }: { readonly run: WorkspaceEnvironmentActionRun }) {
  return (
    <div
      data-testid="action-command-pill"
      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[18px] bg-selected pr-3 pl-3 text-body-small"
    >
      <Play className="size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0 flex-1 text-fade font-mono text-xs text-ink">{commandHeadline(run)}</span>
    </div>
  );
}

/** Intentional stops are not failures, so they have no exit-code pill. */
function ExitPill({ run }: { readonly run: WorkspaceEnvironmentActionRun }) {
  if (run.status !== "failed" || run.exitCode === null) return null;
  return (
    <div
      data-testid="action-exit-pill"
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-selected px-3 text-xs font-medium text-error"
    >
      <span className="size-2 rounded-full bg-error" aria-hidden />
      Exit {run.exitCode}
    </div>
  );
}

/**
 * Project Action controls for row 2. Reruns reuse the terminal to preserve its tab.
 */
export function ActionControls({ workspaceId, threadId, terminal, onClose }: ActionControlsProps) {
  const run = useActionRun(threadId, terminal.actionId ?? "");
  const [pending, setPending] = useState<ActionCommand | null>(null);
  if (!run) return <PanelHeaderSlot slot="row2"><div className="h-8 min-w-0 flex-1" /></PanelHeaderSlot>;

  const runCommand = async (command: ActionCommand) => {
    setPending(command);
    try {
      const transport = getTransport();
      const next = command === "stop"
        ? await transport.stopWorkspaceAction(threadId, run.actionId)
        : await transport.restartWorkspaceAction(threadId, run.actionId);
      if (next) applyActionRun(next, { focus: false });
    } catch (error) {
      showFailure(`Couldn't ${command} ${run.actionName}. Try again.`, error);
    } finally {
      setPending(null);
    }
  };
  const script = run.snapshot.script;
  const copyCommand = () => {
    if (script === null) return;
    void navigator.clipboard.writeText(script).catch((error: unknown) => {
      showFailure("Couldn't copy command", error);
    });
  };
  const editAction = () => useDiffStore.getState().setRightPanelTab(workspaceId, threadId, "environment");
  const running = run.status === "running";
  const finished = run.status === "completed" || run.status === "failed" || run.status === "interrupted";
  return (
    <PanelHeaderSlot slot="row2">
      <CommandPill run={run} />
      <ActionPortPill run={run} threadId={threadId} />
      <ExitPill run={run} />
      {running ? (
        <>
          <IconButton shape="round" aria-label="Restart" disabled={pending !== null} onClick={() => void runCommand("restart")}>
            <RotateCcw />
          </IconButton>
          <IconButton shape="round" aria-label="Stop" disabled={pending !== null} onClick={() => void runCommand("stop")}>
            <Square />
          </IconButton>
        </>
      ) : null}
      {finished ? (
        <IconButton shape="round" aria-label="Run again" disabled={pending !== null} onClick={() => void runCommand("restart")}>
          <Play />
        </IconButton>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton shape="round" aria-label="More terminal actions">
              <Ellipsis />
            </IconButton>
          }
        />
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem label="Edit action" onClick={editAction} />
          {script !== null ? <DropdownMenuItem label="Copy command" onClick={copyCommand} /> : null}
          <DropdownMenuItem label="Close terminal" onClick={() => onClose(terminal.id)} />
        </DropdownMenuContent>
      </DropdownMenu>
    </PanelHeaderSlot>
  );
}
