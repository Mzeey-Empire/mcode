import { useMemo, type ReactElement } from "react";
import { TERMINAL_MAX_PER_SCOPE, type WorkspaceEnvironmentActionRun } from "@mcode/contracts";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { PanelTabStrip, type PanelTabStripItem } from "@/components/panels/shell/PanelTabStrip";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { ActionIcon } from "@/features/projects/actions/ActionIcon";
import { shellActionIconId } from "@/features/projects/actions/action-icons";
import { ThreadActionRunMenu } from "@/features/projects/actions/ThreadActionRunMenu";
import { useProjectActions } from "@/features/projects/actions/useProjectActions";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { ActionTabGlyph, actionBadgeLabel } from "./ActionTabGlyph";
import { TERMINAL_CAP_REASON } from "./terminalTabs";

interface TerminalTabStripProps {
  readonly workspaceId: string;
  /** Null for the threadless shell, which has no Project Actions to offer. */
  readonly threadId: string | null;
  readonly scopeId: string;
  readonly terminals: readonly TerminalInstance[];
  readonly activeId: string | null;
  readonly labels: ReadonlyMap<string, string>;
  /** Keyed by action id within this scope's thread. */
  readonly actionRuns: Readonly<Record<string, WorkspaceEnvironmentActionRun>>;
  readonly onClose: (ptyId: string) => void;
}

/**
 * Row 1 of the Terminal tool: one tab per terminal record and a + capped at {@link TERMINAL_MAX_PER_SCOPE}.
 * In a thread with Project Actions the + opens the Actions menu. Otherwise it opens a shell.
 */
export function TerminalTabStrip(props: TerminalTabStripProps) {
  return props.threadId === null
    ? <TerminalTabs {...props} />
    : <ThreadTerminalTabs {...props} threadId={props.threadId} />;
}

function ThreadTerminalTabs(props: TerminalTabStripProps & { readonly threadId: string }) {
  const { workspaceId, threadId } = props;
  const projectActions = useProjectActions(workspaceId, threadId);
  // Until the Actions are known the + opens the menu, so an early click cannot start a shell the user meant to pick from it.
  const addMenu = !projectActions.loaded || projectActions.loadError !== null || projectActions.actions.length > 0
    ? (trigger: ReactElement) => (
        <ThreadActionRunMenu workspaceId={workspaceId} threadId={threadId} projectActions={projectActions} trigger={trigger} />
      )
    : undefined;
  return <TerminalTabs {...props} addMenu={addMenu} />;
}

function TerminalTabs({
  scopeId,
  terminals,
  activeId,
  labels,
  actionRuns,
  onClose,
  addMenu,
}: TerminalTabStripProps & { readonly addMenu?: (trigger: ReactElement) => ReactElement }) {
  const items = useMemo<readonly PanelTabStripItem[]>(
    () =>
      terminals.map((terminal) => {
        const run = terminal.kind === "action" && terminal.actionId ? actionRuns[terminal.actionId] : undefined;
        return {
          id: terminal.id,
          label: labels.get(terminal.id) ?? terminal.label,
          icon: terminal.kind === "action" ? <ActionTabGlyph run={run} /> : <ActionIcon iconId={shellActionIconId(terminal.label)} command="" size={14} />,
          status: actionBadgeLabel(run),
        };
      }),
    [actionRuns, labels, terminals],
  );
  return (
    <PanelHeaderSlot slot="leading">
      <PanelTabStrip
        items={items}
        activeId={activeId}
        label="Terminals"
        addLabel="New terminal"
        addDisabledReason={terminals.length >= TERMINAL_MAX_PER_SCOPE ? TERMINAL_CAP_REASON : undefined}
        onSelect={(ptyId) => useTerminalStore.getState().setActiveTerminal(scopeId, ptyId)}
        onClose={onClose}
        onAdd={() => createTerminalForScope(scopeId)}
        addMenu={addMenu}
      />
    </PanelHeaderSlot>
  );
}
