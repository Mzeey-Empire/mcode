import { useMemo } from "react";
import { TERMINAL_MAX_PER_SCOPE, type WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { getTransport } from "@/transport";
import { resolveActiveTerminalId } from "./resolveActiveTerminalId";

const EMPTY_SCOPE_TERMINALS: readonly TerminalInstance[] = [];

/** `terminal.behavior.confirmOnKill`: when closing a terminal asks first. */
export type ConfirmOnKill = "never" | "withChildProcesses" | "always";

/** Tooltip on the Terminal tool's disabled + once the scope holds the server's record cap. */
export const TERMINAL_CAP_REASON = `${TERMINAL_MAX_PER_SCOPE} terminals are open. Close one to open another.`;

/** {@link TERMINAL_CAP_REASON} once a scope holds `count` terminals, else null. */
export function terminalCapReason(count: number): string | null {
  return count >= TERMINAL_MAX_PER_SCOPE ? TERMINAL_CAP_REASON : null;
}

/**
 * Row-1 tab labels for a scope's terminal records. Shells that share a label get
 * " (n)" ordinals so each tab stays distinguishable; action records take their
 * Project Action's name.
 */
export function terminalTabLabels(
  terminals: readonly TerminalInstance[],
  actionRuns: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
): ReadonlyMap<string, string> {
  const shells = terminals.filter((terminal) => terminal.kind !== "action");
  const occurrences = new Map<string, number>();
  for (const shell of shells) occurrences.set(shell.label, (occurrences.get(shell.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const terminal of terminals) {
    if (terminal.kind === "action") {
      labels.set(terminal.id, actionRuns[terminal.actionId ?? ""]?.actionName ?? "Project Action");
      continue;
    }
    const ordinal = (seen.get(terminal.label) ?? 0) + 1;
    seen.set(terminal.label, ordinal);
    labels.set(terminal.id, occurrences.get(terminal.label)! > 1 ? `${terminal.label} (${ordinal})` : terminal.label);
  }
  return labels;
}

/** A scope's terminal records and the one its Terminal tool shows. */
export function useScopeTerminals(scopeId: string | null): {
  readonly terminals: readonly TerminalInstance[];
  readonly activeId: string | null;
} {
  const terminals = useTerminalStore((state) =>
    scopeId ? state.terminals[scopeId] ?? EMPTY_SCOPE_TERMINALS : EMPTY_SCOPE_TERMINALS,
  );
  const storedActiveId = useTerminalStore((state) => (scopeId ? state.activeTerminalByScope[scopeId] ?? null : null));
  const activeId = useMemo(
    () => (scopeId ? resolveActiveTerminalId(scopeId, storedActiveId, { [scopeId]: terminals }) : null),
    [scopeId, storedActiveId, terminals],
  );
  return { terminals, activeId };
}

/** First line of an action's command, which is all a one-line pill or a confirmation can show. */
export function commandHeadline(run: WorkspaceEnvironmentActionRun): string {
  return (run.snapshot.script ?? "").split(/\r?\n/, 1)[0] ?? "";
}

/**
 * Running action command requiring close confirmation, or null when none is required.
 * Run state is authoritative for active commands, regardless of child-process probes.
 */
export function runningActionCommand(
  terminal: TerminalInstance,
  actionRuns: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
  confirmOnKill: ConfirmOnKill,
): string | null {
  if (terminal.kind !== "action" || confirmOnKill === "never") return null;
  const run = actionRuns[terminal.actionId ?? ""];
  return run?.status === "running" ? commandHeadline(run) : null;
}

/**
 * Whether closing `terminal` should ask first. An exited, failed or pending-approval
 * record has no process left to stop. If the child-process check itself fails, ask: stopping a
 * process the user did not expect to lose costs more than one extra click.
 */
export async function closeNeedsConfirm(terminal: TerminalInstance, confirmOnKill: ConfirmOnKill): Promise<boolean> {
  if (confirmOnKill === "never") return false;
  if (terminal.state === "exited" || terminal.state === "failed" || terminal.state === "pending") return false;
  if (confirmOnKill === "always") return true;
  try {
    return (await getTransport().terminalHasChildren(terminal.id)).hasChildren;
  } catch {
    return true;
  }
}
