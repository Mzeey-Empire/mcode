import { useEffect, useRef, useState } from "react";
import { Copy, Ellipsis, Trash2, Undo2 } from "lucide-react";
import type { WorkspaceEnvironmentAction } from "@mcode/contracts";
import { IconButton } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PlayGlyph } from "./PlayGlyph";
import { ActionIconPicker } from "../actions/ActionIconPicker";
import {
  COMMAND_PLATFORMS,
  platformHasScript,
  scriptOf,
  withFlag,
  withPlatformScript,
  type CommandPlatform,
} from "./settings-model";

/** How a row's Play button behaves, decided by the panel because it depends on the thread and the saved file. */
export interface ActionPlay {
  /** Why Play is unavailable, or null when it can run. */
  readonly disabledReason: string | null;
  readonly run: () => void;
}

interface ActionEditorProps {
  readonly action: WorkspaceEnvironmentAction;
  /** Validation copy for this action, shown under the command. */
  readonly issue: string | null;
  readonly play: ActionPlay;
  /** Whether a stored approval exists for this In repo action, which offers "Forget approval". */
  readonly approved: boolean;
  /**
   * Where focus goes on mount. `select` highlights the name so a new action can be renamed by typing,
   * and `caret` keeps the keyboard in the editor after a row opens without risking an overwrite.
   */
  readonly focusName: "select" | "caret" | null;
  readonly onChange: (action: WorkspaceEnvironmentAction) => void;
  readonly onRemove: () => void;
  readonly onDuplicate: () => void;
  readonly onForgetApproval: () => void;
}

const TOGGLES = [
  { flag: "runOnStartup", label: "Run on startup", hint: "When a thread starts in a worktree" },
  { flag: "runOnCleanup", label: "Run on cleanup", hint: "Before the worktree is removed" },
] as const;

function ToggleRow({ label, hint, checked, onChange }: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col">
        <span className="text-body-small text-ink">{label}</span>
        <span className="text-caption text-muted">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function CommandEditor({ action, issue, onChange }: Pick<ActionEditorProps, "action" | "issue" | "onChange">) {
  const [platform, setPlatform] = useState<CommandPlatform>("default");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-muted">Command</span>
        <SegmentedControl
          variant="pill"
          size="small"
          aria-label="Command platform"
          value={platform}
          onChange={(value) => setPlatform(value as CommandPlatform)}
          options={COMMAND_PLATFORMS.map(({ value, label }) => ({
            value,
            label,
            marker: value !== "default" && platformHasScript(action.command, value),
          }))}
        />
      </div>
      <Textarea
        aria-label="Command"
        aria-invalid={issue ? true : undefined}
        placeholder="Command to run"
        spellCheck={false}
        value={action.command[platform] ?? ""}
        onChange={(event) =>
          onChange({ ...action, command: withPlatformScript(action.command, platform, event.target.value) })
        }
        className="min-h-14 resize-none rounded-md border-transparent bg-page px-2.5 py-2 font-mono text-xs/[18px] shadow-[inset_0_0_0_1px_var(--color-border)] hover:border-transparent focus-visible:shadow-[inset_0_0_0_1px_var(--color-focus)]"
      />
      {issue ? <FieldError>{issue}</FieldError> : null}
    </div>
  );
}

function MoreMenu({ approved, onDuplicate, onRemove, onForgetApproval }: Pick<ActionEditorProps, "approved" | "onDuplicate" | "onRemove" | "onForgetApproval">) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="More"
        className={`flex size-8 shrink-0 items-center justify-center rounded-full bg-selected text-ink hover:bg-control-border aria-expanded:bg-control-border ${FOCUS_RING_CLASS}`}
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {approved ? (
          <DropdownMenuItem label="Forget approval" icon={<Undo2 />} onClick={onForgetApproval} />
        ) : null}
        <DropdownMenuItem label="Duplicate action" icon={<Copy />} onClick={onDuplicate} />
        <DropdownMenuItem label="Delete action" icon={<Trash2 />} destructive onClick={onRemove} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The expanded editor of one action: icon, name, command per platform, and its run triggers. */
export function ActionEditor({
  action,
  issue,
  play,
  approved,
  focusName,
  onChange,
  onRemove,
  onDuplicate,
  onForgetApproval,
}: ActionEditorProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusName) return;
    nameRef.current?.focus();
    if (focusName === "select") nameRef.current?.select();
  }, [focusName]);
  return (
    <div className="flex flex-col gap-3 rounded-[10px] bg-panel p-3 shadow-[inset_0_0_0_1px_var(--color-border)]">
      <div className="flex items-center gap-2">
        <ActionIconPicker
          value={action.icon}
          command={scriptOf(action.command)}
          onChange={(icon) => {
            const { icon: _previous, ...rest } = action;
            onChange(icon ? { ...rest, icon } : rest);
          }}
        />
        <Input
          size="compact"
          aria-label="Action name"
          value={action.name}
          className="min-w-0 flex-1 rounded-md bg-background px-2.5 font-medium"
          ref={nameRef}
          onChange={(event) => onChange({ ...action, name: event.target.value })}
        />
        <IconButton
          shape="round"
          aria-label="Run action"
          tooltip={play.disabledReason ?? "Run action"}
          disabled={play.disabledReason !== null}
          onClick={play.run}
        >
          <PlayGlyph />
        </IconButton>
        <MoreMenu approved={approved} onDuplicate={onDuplicate} onRemove={onRemove} onForgetApproval={onForgetApproval} />
      </div>
      <CommandEditor action={action} issue={issue} onChange={onChange} />
      <div className="flex flex-col gap-0.5">
        {TOGGLES.map(({ flag, label, hint }) => (
          <ToggleRow
            key={flag}
            label={label}
            hint={hint}
            checked={action[flag] === true}
            onChange={(checked) => onChange(withFlag(action, flag, checked))}
          />
        ))}
      </div>
    </div>
  );
}
