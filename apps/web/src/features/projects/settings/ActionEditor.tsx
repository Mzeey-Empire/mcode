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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PlayGlyph } from "./PlayGlyph";
import { ActionIconPicker } from "../actions/ActionIconPicker";
import {
  ACTION_OPTION_KEYS,
  ACTION_OPTIONS,
  COMMAND_PLATFORMS,
  optionDisabledReason,
  platformHasScript,
  readOption,
  scriptOf,
  withOption,
  withPlatformScript,
  withPreviewUrl,
  type ActionOptionKey,
  type CommandPlatform,
  type SettingsIssueField,
} from "./settings-model";

/** How a row's Play button behaves, decided by the panel because it depends on the thread and the saved file. */
export interface ActionPlay {
  /** Why Play is unavailable, or null when it can run. */
  readonly disabledReason: string | null;
  readonly run: () => void;
}

interface ActionEditorProps {
  readonly action: WorkspaceEnvironmentAction;
  readonly issues: Partial<Record<SettingsIssueField, string>>;
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

function ToggleRow({ label, hint, checked, disabledReason, onChange }: {
  readonly label: string;
  readonly hint: string | null;
  readonly checked: boolean;
  readonly disabledReason: string | null;
  readonly onChange: (checked: boolean) => void;
}) {
  const row = (
    <label className="flex min-h-11 items-center justify-between gap-3">
      <span className={cn("flex min-w-0 flex-col", disabledReason && "opacity-50")}>
        <span className="text-body-small text-ink">{label}</span>
        {hint ? <span className="text-caption text-muted">{hint}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabledReason !== null} onCheckedChange={onChange} />
    </label>
  );
  if (!disabledReason) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

function PreviewUrlField({ action, issue, onChange }: {
  readonly action: WorkspaceEnvironmentAction;
  readonly issue: string | undefined;
  readonly onChange: (action: WorkspaceEnvironmentAction) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 pb-1.5">
      <Input
        size="compact"
        aria-label="Preview URL"
        aria-invalid={issue ? true : undefined}
        placeholder="http://localhost:3000"
        spellCheck={false}
        value={typeof action.openPreview === "string" ? action.openPreview : ""}
        className="rounded-md bg-background px-2.5 font-mono text-xs"
        onChange={(event) => onChange(withPreviewUrl(action, event.target.value))}
      />
      {issue ? <FieldError>{issue}</FieldError> : null}
    </div>
  );
}

function OptionRows({ action, issues, onChange }: Pick<ActionEditorProps, "action" | "issues" | "onChange">) {
  const row = (key: ActionOptionKey) => (
    <ToggleRow
      key={key}
      label={ACTION_OPTIONS[key].label}
      hint={ACTION_OPTIONS[key].hint}
      checked={readOption(action, key)}
      disabledReason={optionDisabledReason(action, key)}
      onChange={(checked) => onChange(withOption(action, key, checked))}
    />
  );
  return (
    <div className="flex flex-col gap-0.5">
      {ACTION_OPTION_KEYS.map((key) =>
        key === "openPreview" && readOption(action, key) ? (
          <div key={key} className="flex flex-col">
            {row(key)}
            <PreviewUrlField action={action} issue={issues.openPreview} onChange={onChange} />
          </div>
        ) : row(key),
      )}
    </div>
  );
}

function CommandEditor({ action, issue, onChange }: Pick<ActionEditorProps, "action" | "onChange"> & { readonly issue: string | undefined }) {
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
  issues,
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
      <CommandEditor action={action} issue={issues.command} onChange={onChange} />
      <OptionRows action={action} issues={issues} onChange={onChange} />
    </div>
  );
}
