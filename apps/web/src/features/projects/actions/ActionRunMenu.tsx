import type { ReactElement } from "react";
import { Pencil, Play, SquareTerminal } from "lucide-react";
import type { WorkspaceEnvironmentAction, WorkspaceEnvironmentActionRun } from "@mcode/contracts/models/workspace-environment";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionIcon } from "./ActionIcon";

/** Props for {@link ActionRunMenu}. */
export interface ActionRunMenuProps {
  /** The button that opens the menu. It carries its own name and tooltip. */
  readonly trigger: ReactElement;
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly runsByActionId: ReadonlyMap<string, WorkspaceEnvironmentActionRun>;
  readonly loadError?: string | null;
  /** Why starting a new terminal is unavailable, or null while the scope has room. */
  readonly terminalCapReason: string | null;
  /** Starts an idle action in a new terminal. */
  readonly onRun: (actionId: string) => void;
  /** Shows the terminal an action already runs in. */
  readonly onOpen: (actionId: string) => void;
  readonly onNewTerminal: () => void;
  readonly onEdit: () => void;
}

/** The first script an action defines, which is all its icon needs to pick a default. */
function actionScript(action: WorkspaceEnvironmentAction): string {
  const { default: fallback, windows, macos, linux } = action.command;
  return fallback ?? windows ?? macos ?? linux ?? "";
}

/**
 * The Actions menu (Paper 12i/12j): every Project Action with its icon, then New terminal, then Edit actions.
 * An idle action starts in a new terminal. One that is running or waiting for approval opens its
 * terminal instead, and only a running one carries the green badge.
 */
export function ActionRunMenu({
  trigger,
  actions,
  runsByActionId,
  loadError = null,
  terminalCapReason,
  onRun,
  onOpen,
  onNewTerminal,
  onEdit,
}: ActionRunMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-56">
        {loadError ? <p role="status" className="px-3 py-2 text-caption text-error">{loadError}</p> : null}
        {actions.map((action) => (
          <ActionRunMenuItem
            key={action.id}
            action={action}
            run={runsByActionId.get(action.id) ?? null}
            terminalCapReason={terminalCapReason}
            onRun={onRun}
            onOpen={onOpen}
          />
        ))}
        {actions.length > 0 || loadError ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          label="New terminal"
          icon={<SquareTerminal />}
          disabledReason={terminalCapReason}
          onClick={onNewTerminal}
        />
        <DropdownMenuSeparator />
        <DropdownMenuItem label="Edit actions" icon={<Pencil />} onClick={onEdit} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionRunMenuItem({
  action,
  run,
  terminalCapReason,
  onRun,
  onOpen,
}: {
  readonly action: WorkspaceEnvironmentAction;
  readonly run: WorkspaceEnvironmentActionRun | null;
  readonly terminalCapReason: string | null;
  readonly onRun: (actionId: string) => void;
  readonly onOpen: (actionId: string) => void;
}) {
  const live = run?.status === "running" || run?.status === "awaiting-approval";
  return (
    <DropdownMenuItem
      data-testid={`project-action-${action.id}`}
      label={action.name}
      icon={<ActionMenuGlyph action={action} running={run?.status === "running"} />}
      trailing={live ? <span className="sr-only">{run?.status === "running" ? "Running" : "Approval required"}</span> : <RunHint />}
      disabledReason={live ? null : terminalCapReason}
      className="group/action"
      onClick={() => (live ? onOpen(action.id) : onRun(action.id))}
    />
  );
}

/** The Action's icon, with the running badge at its corner. */
function ActionMenuGlyph({ action, running }: { readonly action: WorkspaceEnvironmentAction; readonly running: boolean }) {
  return (
    <span className="relative inline-flex">
      <ActionIcon iconId={action.icon} command={actionScript(action)} size={16} />
      {running ? (
        <span
          data-testid="action-menu-badge"
          aria-hidden
          className="absolute -right-[3px] -bottom-[3px] size-2 rounded-full bg-success ring-2 ring-page"
        />
      ) : null}
    </span>
  );
}

/** "Run" appears only while the row is hovered or highlighted, so a menu of idle actions stays quiet. */
function RunHint() {
  return (
    <span
      aria-hidden
      className="flex items-center gap-1 text-caption text-muted opacity-0 group-hover/action:opacity-100 group-data-highlighted/action:opacity-100"
    >
      <Play className="size-3" />
      Run
    </span>
  );
}
