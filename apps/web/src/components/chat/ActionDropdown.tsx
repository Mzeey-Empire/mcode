import { useState } from "react";
import { Settings } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useActionStore } from "@/stores/actionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getLucideIcon } from "@/lib/action-icons";
import { getKeybindingForCommand, formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { ActionEditorDialog } from "./ActionEditorDialog";

/** Props for the ActionDropdown component. */
interface ActionDropdownProps {
  /** Called after an action is run or the editor dialog is opened to close the dropdown. */
  onClose: () => void;
}

/**
 * Dropdown content listing all project actions for the active workspace.
 *
 * Renders action rows with icons, names, optional setup labels, and shortcut hints.
 * The last-used action row receives a subtle highlight. A footer "Manage Actions..."
 * item opens the action editor dialog. When no actions exist, an empty state with an
 * "Add Action..." link is shown instead.
 */
export function ActionDropdown({ onClose }: ActionDropdownProps) {
  const [editorOpen, setEditorOpen] = useState(false);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);

  const actions = useActionStore(
    (s) => s.actionsByWorkspace[activeWorkspaceId ?? ""] ?? [],
  );
  const lastUsedId = useActionStore(
    (s) => s.lastUsedByWorkspace[activeWorkspaceId ?? ""],
  );
  const runAction = useActionStore((s) => s.runAction);

  function handleRunAction(actionId: string) {
    if (!activeWorkspaceId || !activeThreadId) return;
    void runAction(activeWorkspaceId, actionId, activeThreadId);
    onClose();
  }

  function handleOpenEditor() {
    onClose();
    setEditorOpen(true);
  }

  if (actions.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center gap-1.5 px-3 py-4">
          <span
            className="font-mono text-muted-foreground/15"
            style={{ fontSize: 28 }}
            aria-hidden
          >
            ◌
          </span>
          <span
            className="font-mono tracking-[0.18em] text-muted-foreground/40 uppercase"
            style={{ fontSize: 10.5, fontVariant: "small-caps" }}
          >
            No Actions
          </span>
          <button
            type="button"
            className="text-xs text-muted-foreground/60 hover:text-foreground underline-offset-2 hover:underline transition-colors mt-0.5"
            onClick={handleOpenEditor}
          >
            Add Action...
          </button>
        </div>

        {editorOpen && (
          <ActionEditorDialog open={editorOpen} onOpenChange={setEditorOpen} />
        )}
      </>
    );
  }

  return (
    <>
      {actions.map((action) => {
        const Icon = getLucideIcon(action.icon);
        const binding = getKeybindingForCommand(`action.run.${action.id}`);
        const shortcutLabel = binding ? formatKeybinding(binding.key, isMac) : null;
        const isLastUsed = action.id === lastUsedId;

        return (
          <DropdownMenuItem
            key={action.id}
            className={cn(
              "flex items-center justify-between gap-3 min-w-[180px]",
              isLastUsed && "bg-accent/5",
            )}
            onClick={() => handleRunAction(action.id)}
          >
            <span className="flex items-center gap-2 min-w-0">
              <Icon size={13} className="shrink-0 text-muted-foreground" />
              <span className="truncate">{action.name}</span>
              {action.setup && (
                <span
                  className="font-mono text-muted-foreground/30 uppercase shrink-0"
                  style={{ fontSize: 9, fontVariant: "small-caps" }}
                >
                  setup
                </span>
              )}
            </span>

            {shortcutLabel && (
              <span
                className="font-mono text-muted-foreground/50 uppercase shrink-0 ml-auto"
                style={{ fontSize: 10, fontVariant: "small-caps" }}
              >
                {shortcutLabel}
              </span>
            )}
          </DropdownMenuItem>
        );
      })}

      <DropdownMenuSeparator />

      <DropdownMenuItem
        className="flex items-center gap-2 text-muted-foreground"
        onClick={handleOpenEditor}
      >
        <Settings size={13} className="shrink-0" />
        <span>Manage Actions...</span>
      </DropdownMenuItem>

      {editorOpen && (
        <ActionEditorDialog open={editorOpen} onOpenChange={setEditorOpen} />
      )}
    </>
  );
}
