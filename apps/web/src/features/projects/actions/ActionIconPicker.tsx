import { useState } from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionIcon } from "./ActionIcon";
import { ACTION_ICON_IDS, ACTION_ICONS, isActionIconId, resolveActionIconId, type ActionIconId } from "./action-icons";

/** Props for {@link ActionIconPicker}. */
export interface ActionIconPickerProps {
  /** The stored icon id, or undefined while the action uses the icon derived from its command. */
  value: string | undefined;
  /** The action's script, which decides the automatic icon. */
  command: string;
  /** Called with the chosen id, or undefined when the user clears an explicit choice. */
  onChange: (iconId: ActionIconId | undefined) => void;
}

const GROUPS = [
  { label: "Tools", kind: "tool", iconSize: 18 },
  { label: "General", kind: "glyph", iconSize: 16 },
] as const;

/**
 * Icon grid for an action. The cell in use is filled, and choosing the filled cell of an
 * explicit choice clears it, which returns the action to the icon derived from its command.
 */
export function ActionIconPicker({ value, command, onChange }: ActionIconPickerProps) {
  const [open, setOpen] = useState(false);
  const stored = isActionIconId(value) ? value : undefined;
  const shown = resolveActionIconId(value, command);

  const choose = (id: ActionIconId) => {
    onChange(id === stored ? undefined : id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Action icon"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background shadow-[inset_0_0_0_1px_var(--color-control-border)] outline-none hover:shadow-[inset_0_0_0_1px_var(--color-muted)] focus-visible:shadow-[inset_0_0_0_1px_var(--color-focus)] data-popup-open:shadow-[inset_0_0_0_1px_var(--color-focus)]"
      >
        <ActionIcon iconId={stored} command={command} size={16} />
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-[24.4rem] flex-col gap-0.5 p-2">
        {GROUPS.map((group, index) => (
          <section key={group.kind} aria-label={group.label} className="flex flex-col gap-0.5">
            {index > 0 ? <div aria-hidden className="mx-1 my-1 h-px bg-border" /> : null}
            <h3 className="flex h-6 items-center pl-1 text-caption font-medium text-muted">{group.label}</h3>
            <div className="flex flex-wrap gap-0.5">
              {ACTION_ICON_IDS.filter((id) => ACTION_ICONS[id].kind === group.kind).map((id) => (
                <Tooltip key={id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={ACTION_ICONS[id].label}
                        aria-pressed={shown === id}
                        onClick={() => choose(id)}
                        className={cn(
                          "flex size-9 shrink-0 items-center justify-center rounded-md outline-none hover:bg-hover focus-visible:bg-hover",
                          shown === id && "bg-selected",
                        )}
                      >
                        <ActionIcon iconId={id} command="" size={group.iconSize} />
                      </button>
                    }
                  />
                  <TooltipContent>{ACTION_ICONS[id].label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </section>
        ))}
      </PopoverContent>
    </Popover>
  );
}
