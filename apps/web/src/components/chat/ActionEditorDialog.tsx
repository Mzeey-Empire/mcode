import { useState, useEffect, useCallback } from "react";
import { Pencil, Trash2, ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { useActionStore } from "@/stores/actionStore";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { getLucideIcon } from "@/lib/action-icons";
import { ACTION_ICONS } from "@mcode/contracts";
import { formatKeybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import type { Action, ActionIcon } from "@mcode/contracts";

/** Props for the ActionEditorDialog component. */
interface ActionEditorDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Callback to toggle the dialog open state. */
  onOpenChange: (open: boolean) => void;
}

/** Draft state for the edit/add sub-view form fields. */
interface ActionDraft {
  name: string;
  command: string;
  icon: ActionIcon;
  shortcut: string | undefined;
  setup: boolean;
}

/** Default draft values for a new action. */
const DEFAULT_DRAFT: ActionDraft = {
  name: "",
  command: "",
  icon: "play",
  shortcut: undefined,
  setup: false,
};

/**
 * Generates a URL-safe slug from a human-readable action name.
 * Used as the action ID for newly created actions.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Dialog for managing project actions.
 *
 * Contains two views within a single dialog:
 * - List view: shows all actions with edit/delete controls and an "Add action" button.
 * - Edit/Add view: form for creating or editing a single action.
 *
 * No nested modals. Delete confirmation is inline within the list row.
 */
export function ActionEditorDialog({ open, onOpenChange }: ActionEditorDialogProps) {
  const [view, setView] = useState<"list" | "edit">("list");
  const [editingAction, setEditingAction] = useState<Action | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ActionDraft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const actions = useActionStore(
    (s) => s.actionsByWorkspace[activeWorkspaceId ?? ""] ?? [],
  );
  const saveAction = useActionStore((s) => s.saveAction);
  const deleteAction = useActionStore((s) => s.deleteAction);

  // Reset to list view whenever dialog reopens.
  useEffect(() => {
    if (open) {
      setView("list");
      setEditingAction(null);
      setConfirmingDeleteId(null);
      setDraft(DEFAULT_DRAFT);
    }
  }, [open]);

  const handleEditAction = useCallback((action: Action) => {
    setEditingAction(action);
    setDraft({
      name: action.name,
      command: action.command,
      icon: action.icon,
      shortcut: action.shortcut,
      setup: action.setup,
    });
    setView("edit");
  }, []);

  const handleAddAction = useCallback(() => {
    setEditingAction(null);
    setDraft(DEFAULT_DRAFT);
    setView("edit");
  }, []);

  const handleBack = useCallback(() => {
    setView("list");
    setEditingAction(null);
    setDraft(DEFAULT_DRAFT);
  }, []);

  const handleDeleteConfirm = useCallback(
    async (actionId: string) => {
      if (!activeWorkspaceId) return;
      await deleteAction(activeWorkspaceId, actionId);
      setConfirmingDeleteId(null);
    },
    [activeWorkspaceId, deleteAction],
  );

  const handleSave = useCallback(async () => {
    if (!activeWorkspaceId || !draft.name.trim() || !draft.command.trim()) return;

    setSaving(true);
    try {
      const id = editingAction?.id ?? slugify(draft.name.trim());
      const action: Action = {
        id,
        name: draft.name.trim(),
        command: draft.command.trim(),
        icon: draft.icon,
        shortcut: draft.shortcut,
        setup: draft.setup,
      };
      await saveAction(activeWorkspaceId, action);
      setView("list");
      setEditingAction(null);
      setDraft(DEFAULT_DRAFT);
    } finally {
      setSaving(false);
    }
  }, [activeWorkspaceId, draft, editingAction, saveAction]);

  // The action that will be displaced if setup is toggled on.
  const displacedSetupAction =
    draft.setup
      ? actions.find((a) => a.setup && a.id !== editingAction?.id) ?? null
      : null;

  const canSave = draft.name.trim().length > 0 && draft.command.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {view === "list" ? (
          <ListView
            actions={actions}
            confirmingDeleteId={confirmingDeleteId}
            onEdit={handleEditAction}
            onDeleteRequest={(id) => setConfirmingDeleteId(id)}
            onDeleteConfirm={handleDeleteConfirm}
            onDeleteCancel={() => setConfirmingDeleteId(null)}
            onAdd={handleAddAction}
          />
        ) : (
          <EditView
            editingAction={editingAction}
            draft={draft}
            actions={actions}
            displacedSetupAction={displacedSetupAction}
            saving={saving}
            canSave={canSave}
            onDraftChange={setDraft}
            onBack={handleBack}
            onCancel={handleBack}
            onSave={handleSave}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ListViewProps + ListRow
// ---------------------------------------------------------------------------

/** Props for the ListView sub-component. */
interface ListViewProps {
  actions: Action[];
  confirmingDeleteId: string | null;
  onEdit: (action: Action) => void;
  onDeleteRequest: (id: string) => void;
  onDeleteConfirm: (id: string) => Promise<void>;
  onDeleteCancel: () => void;
  onAdd: () => void;
}

/**
 * List view rendered inside the action editor dialog.
 * Shows all project actions with inline edit/delete controls.
 */
function ListView({
  actions,
  confirmingDeleteId,
  onEdit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  onAdd,
}: ListViewProps) {
  return (
    <div className="flex flex-col gap-3">
      <DialogTitle
        className={cn(
          "font-mono uppercase tracking-[0.18em] text-muted-foreground/40",
          "text-[10.5px]",
        )}
      >
        Project Actions
      </DialogTitle>

      <div className="flex flex-col">
        {actions.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-6">
            <span
              className="font-mono text-muted-foreground/15"
              style={{ fontSize: 28 }}
              aria-hidden
            >
              ◌
            </span>
            <span
              className="font-mono tracking-[0.18em] text-muted-foreground/40 uppercase"
              style={{ fontSize: 10.5 }}
            >
              No Actions
            </span>
          </div>
        ) : (
          actions.map((action) => (
            <ActionRow
              key={action.id}
              action={action}
              isConfirmingDelete={confirmingDeleteId === action.id}
              onEdit={() => onEdit(action)}
              onDeleteRequest={() => onDeleteRequest(action.id)}
              onDeleteConfirm={() => onDeleteConfirm(action.id)}
              onDeleteCancel={onDeleteCancel}
            />
          ))
        )}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1.5 self-start text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
      >
        <span className="text-base leading-none">+</span>
        <span>Add action</span>
      </button>

      {/* Footer separator and open file link */}
      <div className="border-t pt-2 -mx-4 px-4">
        <button
          type="button"
          className="flex items-center gap-1 text-[10.5px] font-mono text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors uppercase tracking-[0.12em]"
          onClick={() => {
            // The file path is server-side only; gracefully skip if unavailable.
            // Future: add a transport method to return the path.
          }}
          disabled
          title="actions.json location is resolved server-side"
        >
          Open actions.json ↗
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionRow
// ---------------------------------------------------------------------------

/** Props for a single row in the action list. */
interface ActionRowProps {
  action: Action;
  isConfirmingDelete: boolean;
  onEdit: () => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => Promise<void>;
  onDeleteCancel: () => void;
}

/**
 * Single row in the action list showing icon, name, shortcut badge, setup label,
 * and edit/delete icon buttons. Delete shows an inline confirm prompt.
 */
function ActionRow({
  action,
  isConfirmingDelete,
  onEdit,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: ActionRowProps) {
  const Icon = getLucideIcon(action.icon);
  const shortcutLabel = action.shortcut ? formatKeybinding(action.shortcut, isMac) : null;

  return (
    <div className="group flex items-center gap-2 rounded-md px-1 py-1.5 hover:bg-muted/50 transition-colors">
      <Icon size={14} className="shrink-0 text-muted-foreground/60" aria-hidden />

      <span className="flex-1 truncate text-sm">{action.name}</span>

      {shortcutLabel && (
        <span
          className="font-mono text-muted-foreground/40 uppercase shrink-0"
          style={{ fontSize: 10, fontVariant: "small-caps" }}
        >
          {shortcutLabel}
        </span>
      )}

      {action.setup && (
        <span
          className="font-mono text-muted-foreground/30 uppercase shrink-0"
          style={{ fontSize: 9, fontVariant: "small-caps" }}
        >
          setup
        </span>
      )}

      {isConfirmingDelete ? (
        <span className="flex items-center gap-1.5 text-xs shrink-0">
          <span className="text-destructive font-medium">Delete?</span>
          <button
            type="button"
            onClick={onDeleteConfirm}
            className="text-destructive hover:text-destructive/80 transition-colors"
          >
            Confirm
          </button>
          <button
            type="button"
            onClick={onDeleteCancel}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEdit}
            aria-label={`Edit ${action.name}`}
          >
            <Pencil size={14} className="text-muted-foreground/50" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDeleteRequest}
            aria-label={`Delete ${action.name}`}
          >
            <Trash2 size={14} className="text-muted-foreground/50" />
          </Button>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditView
// ---------------------------------------------------------------------------

/** Props for the EditView sub-component. */
interface EditViewProps {
  editingAction: Action | null;
  draft: ActionDraft;
  actions: Action[];
  displacedSetupAction: Action | null;
  saving: boolean;
  canSave: boolean;
  onDraftChange: (draft: ActionDraft) => void;
  onBack: () => void;
  onCancel: () => void;
  onSave: () => Promise<void>;
}

/**
 * Edit/Add sub-view rendered inside the action editor dialog.
 * Replaces the list content without opening a nested modal.
 */
function EditView({
  editingAction,
  draft,
  actions,
  displacedSetupAction,
  saving,
  canSave,
  onDraftChange,
  onBack,
  onCancel,
  onSave,
}: EditViewProps) {
  const isNew = editingAction === null;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground transition-colors"
          aria-label="Back to action list"
        >
          <ChevronLeft size={14} />
          <span>Back</span>
        </button>
        <DialogTitle
          className={cn(
            "font-mono uppercase tracking-[0.18em] text-muted-foreground/40",
            "text-[10.5px]",
          )}
        >
          {isNew ? "New Action" : "Edit Action"}
        </DialogTitle>
      </div>

      {/* Name field */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="action-name" className="text-xs">
          Name
        </Label>
        <Input
          id="action-name"
          size="sm"
          placeholder="e.g. Run Tests"
          value={draft.name}
          onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
          autoFocus
        />
      </div>

      {/* Command field */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="action-command" className="text-xs">
          Command
        </Label>
        <Input
          id="action-command"
          size="sm"
          placeholder="e.g. bun run test"
          value={draft.command}
          onChange={(e) => onDraftChange({ ...draft, command: e.target.value })}
          className="font-mono"
        />
      </div>

      {/* Icon picker */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">Icon</Label>
        <div className="grid grid-cols-8 gap-1">
          {ACTION_ICONS.map((iconName) => {
            const IconComponent = getLucideIcon(iconName);
            const isSelected = draft.icon === iconName;
            return (
              <button
                key={iconName}
                type="button"
                onClick={() => onDraftChange({ ...draft, icon: iconName })}
                aria-label={iconName}
                aria-pressed={isSelected}
                className={cn(
                  "flex items-center justify-center rounded-md p-1.5 transition-colors",
                  isSelected
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
                )}
              >
                <IconComponent size={14} />
              </button>
            );
          })}
        </div>
      </div>

      {/* Shortcut recorder */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">Shortcut</Label>
        <ShortcutRecorder
          value={draft.shortcut}
          onChange={(shortcut) => onDraftChange({ ...draft, shortcut })}
          siblingShortcuts={actions.map((a) => ({
            id: a.id,
            name: a.name,
            shortcut: a.shortcut,
          }))}
          currentActionId={editingAction?.id}
        />
      </div>

      {/* Setup switch */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <Label htmlFor="action-setup" className="text-xs cursor-pointer">
            Setup action
          </Label>
          <Switch
            id="action-setup"
            checked={draft.setup}
            onCheckedChange={(checked) =>
              onDraftChange({ ...draft, setup: checked })
            }
          />
        </div>
        {displacedSetupAction && (
          <p className="text-[10.5px] text-muted-foreground/60">
            Replaced &apos;{displacedSetupAction.name}&apos; as setup action
          </p>
        )}
      </div>

      {/* Footer buttons */}
      <div className="flex items-center justify-end gap-2 border-t pt-3 -mx-4 px-4 -mb-4 pb-4 bg-muted/50 rounded-b-xl">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={!canSave || saving}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
