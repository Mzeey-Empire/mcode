import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { MENU_LIST_CLASS, MENU_ROW_CLASS, MENU_ROW_DISABLED_CLASS, MenuRowBody } from "@/components/ui/menu-row";
import { SlidingHighlight } from "@/components/ui/sliding-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AccessOption, ComposerAccessModel } from "./ComposerAccessControls";

const MOVE_KEYS: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowDown: (index, count) => (index + 1) % count,
  ArrowUp: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

/** Props for {@link AccessOptionList}. */
export interface AccessOptionListProps {
  readonly access: ComposerAccessModel;
  /** Runs after an enabled option is chosen, so the host can close its popover. */
  readonly onChosen: () => void;
}

/**
 * The access popover body: a listbox of the provider's access options with the current one checked. Focus starts on
 * the checked option and follows the pointer, as in a menu; the arrow keys wrap, Home and End reach the ends, and
 * Enter or Space chooses. A dimmed option explains itself in a tooltip and its accessible description.
 */
export function AccessOptionList({ access, onChosen }: AccessOptionListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = MOVE_KEYS[event.key];
    const options = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (!move || options.length === 0) return;
    event.preventDefault();
    const current = options.findIndex((option) => option === document.activeElement);
    options[move(Math.max(current, 0), options.length)]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Access"
      onKeyDown={moveFocus}
      className={cn("relative w-60", MENU_LIST_CLASS)}
    >
      <SlidingHighlight follow={{ pointer: '[role="option"]' }} />
      {access.options.map((option) => (
        <AccessOptionRow
          key={option.id}
          option={option}
          checked={option.id === access.selected.id}
          onChoose={() => {
            access.choose(option.id);
            onChosen();
          }}
        />
      ))}
    </div>
  );
}

function AccessOptionRow({
  option,
  checked,
  onChoose,
}: {
  readonly option: AccessOption;
  readonly checked: boolean;
  readonly onChoose: () => void;
}) {
  const reasonId = useId();
  const Icon = option.icon;
  const disabled = option.disabledReason !== null;
  const row = (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? reasonId : undefined}
      data-disabled={disabled || undefined}
      tabIndex={checked ? 0 : -1}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") event.currentTarget.focus();
      }}
      onClick={() => {
        if (!disabled) onChoose();
      }}
      className={cn(MENU_ROW_CLASS, MENU_ROW_DISABLED_CLASS)}
    >
      <MenuRowBody label={option.label} icon={<Icon />} checked={checked} />
      {disabled ? <span id={reasonId} hidden>{option.disabledReason}</span> : null}
    </button>
  );
  if (!disabled) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="right">{option.disabledReason}</TooltipContent>
    </Tooltip>
  );
}
