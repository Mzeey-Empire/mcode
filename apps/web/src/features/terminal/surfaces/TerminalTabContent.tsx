import { useMemo } from "react";
import type { WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { useProjectActionStore } from "@/features/projects/environment/state/project-action-store";
import { ActionControls } from "./ActionControls";
import { ShellControls } from "./ShellControls";
import { TerminalCloseConfirm } from "./TerminalCloseConfirm";
import { TerminalTabStrip } from "./TerminalTabStrip";
import { terminalTabLabels, useScopeTerminals } from "./terminalTabs";
import { useTerminalClose } from "./useTerminalClose";

const EMPTY_ACTION_RUNS: Readonly<Record<string, WorkspaceEnvironmentActionRun>> = {};

/** Props for {@link TerminalTabContent}. */
interface TerminalTabContentProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly scopeId: string;
}

/**
 * The Terminal tool's header chrome: row-1 terminal tabs, row-2 shell controls for
 * the active shell, and the close confirmation. xterm instances render in the
 * pooled slot, not here.
 */
export function TerminalTabContent({ workspaceId, threadId, scopeId }: TerminalTabContentProps) {
  const { terminals, activeId } = useScopeTerminals(scopeId);
  const actionRuns = useProjectActionStore((state) =>
    threadId ? state.runsByThread[threadId] ?? EMPTY_ACTION_RUNS : EMPTY_ACTION_RUNS,
  );
  const labels = useMemo(() => terminalTabLabels(terminals, actionRuns), [terminals, actionRuns]);
  const closeScope = useMemo(() => ({ workspaceId, threadId, scopeId }), [workspaceId, threadId, scopeId]);
  const { pending, requestClose, confirmClose, cancelClose } = useTerminalClose(
    closeScope,
    terminals,
    labels,
    actionRuns,
  );
  const active = terminals.find((terminal) => terminal.id === activeId) ?? null;
  return (
    <>
      <TerminalTabStrip
        workspaceId={workspaceId}
        threadId={threadId}
        scopeId={scopeId}
        terminals={terminals}
        activeId={activeId}
        labels={labels}
        actionRuns={actionRuns}
        onClose={(ptyId) => void requestClose(ptyId)}
      />
      {active?.kind === "action" && threadId ? (
        <ActionControls
          workspaceId={workspaceId}
          threadId={threadId}
          terminal={active}
          onClose={(ptyId) => void requestClose(ptyId)}
        />
      ) : null}
      {active && active.kind !== "action" ? (
        <ShellControls
          workspaceId={workspaceId}
          threadId={threadId}
          terminal={active}
          onClose={(ptyId) => void requestClose(ptyId)}
        />
      ) : null}
      {pending ? (
        <TerminalCloseConfirm
          name={pending.name}
          anchor={pending.anchor}
          command={pending.command}
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      ) : null}
    </>
  );
}
