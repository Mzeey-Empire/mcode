import type { ReactElement } from "react";
import { useToastStore } from "@/stores/toastStore";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { openRightPanelTab } from "@/lib/right-panel-layout";
import { useTerminalStore } from "@/features/terminal/state/terminalStore";
import { terminalCapReason } from "@/features/terminal/surfaces/terminalTabs";
import { useProjectActionStore } from "../environment/state/project-action-store";
import { ActionRunMenu } from "./ActionRunMenu";
import type { useProjectActions } from "./useProjectActions";

/** The record a Project Action runs in, matched by owner first and by the run's session as a fallback. */
function findActionTerminalId(threadId: string, actionId: string): string | null {
  const records = useTerminalStore.getState().terminals[threadId] ?? [];
  const owned = records.find((terminal) => terminal.actionId === actionId);
  if (owned) return owned.id;
  return useProjectActionStore.getState().runsByThread[threadId]?.[actionId]?.terminalSessionId ?? null;
}

/** Props for {@link ThreadActionRunMenu}. */
export interface ThreadActionRunMenuProps {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly trigger: ReactElement;
  readonly projectActions: ReturnType<typeof useProjectActions>;
  /** Replaces the default jump to Project settings, for a host that must close its own popover first. */
  readonly onEdit?: () => void;
}

/**
 * {@link ActionRunMenu} wired to a thread: every pick reveals the Terminal tool first, because a
 * terminal can only attach to a visible panel.
 */
export function ThreadActionRunMenu({ workspaceId, threadId, trigger, projectActions, onEdit }: ThreadActionRunMenuProps) {
  const terminalCount = useTerminalStore((state) => state.terminals[threadId]?.length ?? 0);
  return (
    <ActionRunMenu
      trigger={trigger}
      actions={projectActions.actions}
      runsByActionId={projectActions.runsByActionId}
      loadError={projectActions.loadError}
      terminalCapReason={terminalCapReason(terminalCount)}
      onRun={(actionId) => {
        openRightPanelTab(workspaceId, threadId, "terminal");
        projectActions.start(actionId).catch(() => {
          useToastStore.getState().show({ kind: "failed", title: "Project Action could not start" });
        });
      }}
      onOpen={(actionId) => {
        openRightPanelTab(workspaceId, threadId, "terminal");
        const ptyId = findActionTerminalId(threadId, actionId);
        if (ptyId) useTerminalStore.getState().setActiveTerminal(threadId, ptyId);
      }}
      onNewTerminal={() => {
        openRightPanelTab(workspaceId, threadId, "terminal");
        createTerminalForScope(threadId);
      }}
      onEdit={onEdit ?? (() => openRightPanelTab(workspaceId, threadId, "environment"))}
    />
  );
}
