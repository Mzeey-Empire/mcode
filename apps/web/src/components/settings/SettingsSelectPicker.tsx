import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { tokenizeSearch, matchesAllTokens } from "@/lib/searchTokens";
import { Button } from "@/components/ui/button";
import { PICKER_PANEL_CLASS, Picker, type PickerRow } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** One choice in a {@link SettingsSelectPicker}. */
export interface SettingsPickOption {
  /** Saved value. The empty string is a real choice, such as "Auto" or "Off". */
  readonly value: string;
  readonly label: string;
  /** What the option stands for right now, such as the app "Auto" resolves to; muted after the label as "· detail". */
  readonly detail?: string;
  /** Shown as the row's muted tag when the options span more than one group, e.g. the model family. */
  readonly group?: string;
  readonly disabled?: boolean;
  /** Drawn before the label on its row, and on the trigger when chosen. */
  readonly icon?: ReactNode;
  /** Why a disabled option is unavailable. Ignored on enabled options. */
  readonly title?: string;
}

interface SettingsSelectPickerProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly options: readonly SettingsPickOption[];
  /** Trigger text when no option carries the current value. */
  readonly emptyTriggerLabel?: string;
  readonly searchPlaceholder?: string;
  readonly disabled?: boolean;
  /** Shows "Loading…" on the trigger and blocks opening while the catalog loads. */
  readonly loading?: boolean;
  readonly align?: "start" | "center" | "end";
  readonly "data-testid"?: string;
  /** Names the trigger when its text is only the value, such as a profile picker in a search result. */
  readonly "aria-label"?: string;
}

/** A tag that repeats on every row says nothing, so groups show only when there are at least two. */
function hasSeveralGroups(options: readonly SettingsPickOption[]): boolean {
  return new Set(options.map((o) => o.group)).size > 1;
}

function toRow(option: SettingsPickOption, showGroup: boolean): PickerRow {
  return {
    key: option.value,
    name: option.label,
    icon: option.icon,
    tag: option.detail ?? (showGroup ? option.group : undefined),
    disabled: option.disabled,
    disabledReason: option.disabled ? option.title : undefined,
  };
}

/** Prefers an enabled match so a value listed twice (catalog and stale saved row) shows the live label. */
function findSelected(options: readonly SettingsPickOption[], value: string): SettingsPickOption | undefined {
  return options.find((o) => o.value === value && !o.disabled) ?? options.find((o) => o.value === value);
}

function TriggerLabel({ selected, text, ready }: { readonly selected?: SettingsPickOption; readonly text: string; readonly ready: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {ready && selected?.icon != null ? (
        <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-muted [&_svg]:size-[1.4rem]">
          {selected.icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 text-fade text-left">
        {text}
        {ready && selected?.detail ? <span className="text-muted"> · {selected.detail}</span> : null}
      </span>
    </span>
  );
}

/**
 * Settings select built on {@link Picker}: a borderless pill trigger that opens a searchable,
 * client-filtered list of a fixed option set. Search matches every whitespace-separated token
 * against the label, value and group.
 */
export function SettingsSelectPicker({
  value,
  onChange,
  options,
  emptyTriggerLabel = "Choose…",
  searchPlaceholder = "Search",
  disabled,
  loading,
  align = "end",
  "data-testid": testId,
  "aria-label": ariaLabel,
}: SettingsSelectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = findSelected(options, value);
  const showGroup = hasSeveralGroups(options);
  const renderRow = useCallback((option: SettingsPickOption) => toRow(option, showGroup), [showGroup]);

  const filtered = useMemo(() => {
    const tokens = tokenizeSearch(query);
    return options.filter((o) => matchesAllTokens([o.label, o.value, o.group ?? "", o.detail ?? ""], tokens));
  }, [options, query]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            disabled={disabled || loading}
            data-testid={testId}
            aria-label={ariaLabel}
            className="max-w-[28rem] justify-between gap-1.5 rounded-full pr-2 pl-3 font-normal hover:bg-hover data-popup-open:bg-hover"
          >
            <TriggerLabel
              selected={selected}
              text={loading ? "Loading…" : (selected?.label ?? (value || emptyTriggerLabel))}
              ready={!loading}
            />
            <ChevronDown aria-hidden className="size-4 shrink-0 text-muted" />
          </Button>
        }
      />
      <PopoverContent align={align} side="bottom" sideOffset={4} className={PICKER_PANEL_CLASS}>
        <Picker
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={searchPlaceholder}
          items={filtered}
          total={null}
          status="ready"
          selectedKey={value}
          renderItem={renderRow}
          onSelect={(option) => {
            onChange(option.value);
            handleOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
