import { useCallback, useRef, useState } from "react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { useDiffStore } from "@/stores/diffStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { closeNeedsConfirm, runningActionCommand, type ConfirmOnKill } from "./terminalTabs";

/** A close waiting on the user's answer, anchored to the tab it came from. */
export interface PendingClose {
  readonly ptyId: string;
  readonly name: string;
  readonly anchor: HTMLElement | null;
  /** Present only when closing would stop a running Project Action. */
  readonly command?: string;
}

interface CloseScope {
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly scopeId: string;
}

/**
 * On failure the record stays: the process may still be running, and the user
 * needs to know closing it did not stop it.
 */
async function closeTerminalRecord(scope: CloseScope, ptyId: string, name: string): Promise<void> {
  try {
    await getTransport().terminalKill(ptyId);
  } catch (error) {
    useToastStore.getState().show({
      kind: "failed",
      title: `Couldn't close ${name}. Try again.`,
      meta: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  useTerminalStore.getState().removeTerminal(ptyId);
  if ((useTerminalStore.getState().terminals[scope.scopeId]?.length ?? 0) > 0) return;
  useDiffStore.getState().closeRightPanelTab(scope.workspaceId, scope.threadId, "terminal");
}

async function closeQuestion(
  terminal: TerminalInstance,
  actionRuns: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
  confirmOnKill: ConfirmOnKill,
): Promise<{ readonly command?: string } | null> {
  const command = runningActionCommand(terminal, actionRuns, confirmOnKill);
  if (command !== null) return { command };
  return (await closeNeedsConfirm(terminal, confirmOnKill)) ? {} : null;
}

interface TerminalClose {
  readonly pending: PendingClose | null;
  readonly requestClose: (ptyId: string) => Promise<void>;
  readonly confirmClose: () => void;
  readonly cancelClose: () => void;
}

/**
 * Close flow for one scope's terminals, including the `confirmOnKill` popover.
 *
 * The child-process probe is async, so answers can arrive out of order. Only the
 * newest request may show a confirmation, otherwise a slow probe for one tab
 * would swap the question the user is already reading for another tab's.
 */
export function useTerminalClose(
  scope: CloseScope,
  terminals: readonly TerminalInstance[],
  labels: ReadonlyMap<string, string>,
  actionRuns: Readonly<Record<string, WorkspaceEnvironmentActionRun>>,
): TerminalClose {
  const confirmOnKill = useSettingsStore((state) => state.settings.terminal.behavior.confirmOnKill);
  const [asked, setAsked] = useState<PendingClose | null>(null);
  // A reconcile can remove the record (and its tab) while the question is open.
  const pending =
    asked && terminals.some((terminal) => terminal.id === asked.ptyId) && (asked.anchor?.isConnected ?? true)
      ? asked
      : null;
  const latestRequest = useRef(0);

  const requestClose = useCallback(
    async (ptyId: string) => {
      const terminal = terminals.find((candidate) => candidate.id === ptyId);
      if (!terminal) return;
      const name = labels.get(ptyId) ?? terminal.label;
      const request = ++latestRequest.current;
      const question = await closeQuestion(terminal, actionRuns, confirmOnKill);
      const current = useTerminalStore.getState().terminals[scope.scopeId]?.find((candidate) => candidate.id === ptyId);
      if (!current) return;
      const exitedDuringProbe = current.state === "exited" || current.state === "failed";
      if (!question || exitedDuringProbe) {
        await closeTerminalRecord(scope, ptyId, name);
        return;
      }
      if (request !== latestRequest.current) return;
      const anchor = document.querySelector<HTMLElement>(`[data-panel-tab="${CSS.escape(ptyId)}"]`);
      setAsked({ ptyId, name, anchor, ...question });
    },
    [terminals, labels, actionRuns, confirmOnKill, scope],
  );

  const confirmClose = useCallback(() => {
    if (!pending) return;
    setAsked(null);
    void closeTerminalRecord(scope, pending.ptyId, pending.name);
  }, [pending, scope]);

  const cancelClose = useCallback(() => setAsked(null), []);
  return { pending, requestClose, confirmClose, cancelClose };
}
