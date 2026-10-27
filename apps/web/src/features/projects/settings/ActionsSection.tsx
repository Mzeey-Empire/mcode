import { useEffect, useRef, useState } from "react";
import type { WorkspaceEnvironmentAction } from "@mcode/contracts/models/workspace-environment";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { PlayGlyph } from "./PlayGlyph";
import { ActionIcon } from "../actions/ActionIcon";
import { ActionEditor, type ActionPlay } from "./ActionEditor";
import { optionChips, scriptOf, type SettingsIssueField } from "./settings-model";

function Chip({ children }: { readonly children: string }) {
  return (
    <Badge variant="secondary" size="compact" className="h-[22px] rounded-full px-2">
      {children}
    </Badge>
  );
}

function CollapsedRow({ action, play, restoreFocus, onToggle }: {
  readonly action: WorkspaceEnvironmentAction;
  readonly play: ActionPlay;
  /** Takes focus on mount, for the row an Escape just collapsed so the keyboard keeps its place. */
  readonly restoreFocus: boolean;
  readonly onToggle: () => void;
}) {
  const command = scriptOf(action.command);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (restoreFocus) toggleRef.current?.focus();
  }, [restoreFocus]);
  return (
    <div className="flex h-11 items-center gap-2.5 rounded-[10px] bg-panel pr-1.5 pl-3">
      <Button
        ref={toggleRef}
        variant="ghost"
        aria-expanded={false}
        onClick={onToggle}
        className="h-full min-w-0 flex-1 justify-start gap-2.5 rounded-control px-0 text-left font-normal hover:bg-transparent"
      >
        <ActionIcon iconId={action.icon} command={command} size={16} />
        <span className="shrink-0 text-body-small font-medium text-ink">{action.name}</span>
        <span className="text-fade min-w-0 flex-1 overflow-clip text-left font-mono text-xs whitespace-nowrap text-muted">{command}</span>
        {optionChips(action).map((chip) => <Chip key={chip}>{chip}</Chip>)}
      </Button>
      <IconButton
        shape="round"
        aria-label={`Run ${action.name}`}
        tooltip={play.disabledReason ?? `Run ${action.name}`}
        disabled={play.disabledReason !== null}
        onClick={play.run}
      >
        <PlayGlyph />
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
  readonly issuesFor: (actionId: string) => Partial<Record<SettingsIssueField, string>>;
  readonly playFor: (action: WorkspaceEnvironmentAction) => ActionPlay;
  readonly onExpand: (actionId: string | null) => void;
  readonly onChange: (action: WorkspaceEnvironmentAction) => void;
  readonly onRemove: (actionId: string) => void;
  readonly onDuplicate: (actionId: string) => void;
  readonly onForgetApproval: (actionId: string) => void;
}

/** The list of a Project's actions, one open at a time. */
export function ActionsSection({
  actions,
  expandedActionId,
  focusNameActionId,
  approvedActionIds,
  issuesFor,
  playFor,
  onExpand,
  onChange,
  onRemove,
  onDuplicate,
  onForgetApproval,
}: ActionsSectionProps) {
  const [collapsedByEscapeId, setCollapsedByEscapeId] = useState<string | null>(null);
  // The row's button unmounts when it opens, which would drop keyboard focus without this.
  const [openedActionId, setOpenedActionId] = useState<string | null>(null);
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
                setCollapsedByEscapeId(action.id);
                onExpand(null);
              }
            }}
          >
            {expanded ? (
              <ActionEditor
                action={action}
                issues={issuesFor(action.id)}
                play={playFor(action)}
                approved={approvedActionIds.includes(action.id)}
                focusName={action.id === focusNameActionId ? "select" : action.id === openedActionId ? "caret" : null}
                onChange={onChange}
                onRemove={() => onRemove(action.id)}
                onDuplicate={() => onDuplicate(action.id)}
                onForgetApproval={() => onForgetApproval(action.id)}
              />
            ) : (
              <CollapsedRow
                action={action}
                play={playFor(action)}
                restoreFocus={action.id === collapsedByEscapeId}
                onToggle={() => {
                  setOpenedActionId(action.id);
                  onExpand(action.id);
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
