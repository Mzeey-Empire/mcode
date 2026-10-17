import { Play } from "lucide-react";
import type { WorkspaceEnvironmentAction } from "@mcode/contracts";
import { IconButton } from "@/components/ui/button";
import { ActionIcon } from "../actions/ActionIcon";
import { ActionEditor, type ActionPlay } from "./ActionEditor";
import { scriptOf } from "./settings-model";

function Chip({ children }: { readonly children: string }) {
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center rounded-full bg-selected px-2 text-caption text-ink">
      {children}
    </span>
  );
}

function CollapsedRow({ action, play, onToggle }: {
  readonly action: WorkspaceEnvironmentAction;
  readonly play: ActionPlay;
  readonly onToggle: () => void;
}) {
  const command = scriptOf(action.command);
  return (
    <div className="flex h-11 items-center gap-2.5 rounded-[10px] bg-panel pr-1.5 pl-3">
      <button
        type="button"
        aria-expanded={false}
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-focus"
      >
        <ActionIcon iconId={action.icon} command={command} size={16} />
        <span className="shrink-0 text-body-small font-medium text-ink">{action.name}</span>
        <span className="text-fade min-w-0 flex-1 font-mono text-xs whitespace-nowrap text-muted">{command}</span>
        {action.runOnStartup ? <Chip>On startup</Chip> : null}
        {action.runOnCleanup ? <Chip>On cleanup</Chip> : null}
      </button>
      <IconButton
        shape="round"
        aria-label={`Run ${action.name}`}
        tooltip={play.disabledReason ?? `Run ${action.name}`}
        disabled={play.disabledReason !== null}
        onClick={play.run}
      >
        <Play className="size-3" />
      </IconButton>
    </div>
  );
}

interface ActionsSectionProps {
  readonly actions: readonly WorkspaceEnvironmentAction[];
  readonly expandedActionId: string | null;
  /** The action added in this session, whose name field takes focus and selection. */
  readonly focusNameActionId: string | null;
  readonly approvedActionIds: readonly string[];
  readonly issueFor: (actionId: string) => string | null;
  readonly playFor: (action: WorkspaceEnvironmentAction) => ActionPlay;
  readonly onExpand: (actionId: string | null) => void;
  readonly onChange: (action: WorkspaceEnvironmentAction) => void;
  readonly onRemove: (actionId: string) => void;
  readonly onForgetApproval: (actionId: string) => void;
}

/** The list of a Project's actions, one open at a time. */
export function ActionsSection({
  actions,
  expandedActionId,
  focusNameActionId,
  approvedActionIds,
  issueFor,
  playFor,
  onExpand,
  onChange,
  onRemove,
  onForgetApproval,
}: ActionsSectionProps) {
  if (actions.length === 0) return <p className="px-1 py-2 text-caption text-muted">No actions</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {actions.map((action) => {
        const expanded = action.id === expandedActionId;
        return (
          <li
            key={action.id}
            onKeyDown={(event) => {
              // Escape inside a menu or popover closes that layer, not the editor under it.
              if (event.key === "Escape" && expanded && event.currentTarget.contains(event.target as Node) && !event.defaultPrevented) {
                onExpand(null);
              }
            }}
          >
            {expanded ? (
              <ActionEditor
                action={action}
                issue={issueFor(action.id)}
                play={playFor(action)}
                approved={approvedActionIds.includes(action.id)}
                focusName={action.id === focusNameActionId}
                onChange={onChange}
                onRemove={() => onRemove(action.id)}
                onForgetApproval={() => onForgetApproval(action.id)}
              />
            ) : (
              <CollapsedRow
                action={action}
                play={playFor(action)}
                onToggle={() => onExpand(action.id)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
