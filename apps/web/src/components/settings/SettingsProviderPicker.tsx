import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { tokenizeSearch, matchesAllTokens } from "@/lib/searchTokens";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Matches Tailwind `w-[52px]` for alignment with the composer model picker rail. */
const LEFT_RAIL_WIDTH_CLASS = "w-[52px]";

/** cmdk rejects empty `value`; utility “Auto” uses an empty provider id. */
const EMPTY_PROVIDER_CMDK = "__mcode_provider_auto__";

/** One selectable provider row for {@link SettingsProviderPicker}. */
export interface SettingsProviderPickOption {
  value: string;
  label: string;
  disabled: boolean;
  icon?: ReactNode;
  title?: string;
}

interface SettingsProviderPickerProps {
  /** Current provider id (empty string allowed for utility "Auto" mode). */
  value: string;
  /** Called when the user commits a provider selection. */
  onChange: (providerId: string) => void;
  /** Ordered options (typically aligned with {@link MODEL_PROVIDERS}). */
  options: SettingsProviderPickOption[];
  /** Popover alignment relative to the trigger. */
  align?: "start" | "center" | "end";
  /** Optional test id on the trigger button. */
  "data-testid"?: string;
}

/**
 * Settings provider selector with an icon-first rail and searchable list,
 * consistent with the composer {@link ModelSelector} layout.
 */
export function SettingsProviderPicker({
  value,
  onChange,
  options,
  align = "end",
  "data-testid": testId,
}: SettingsProviderPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const selected = useMemo(
    () =>
      options.find((o) => o.value === value && !o.disabled) ??
      options.find((o) => o.value === value),
    [options, value],
  );

  const filtered = useMemo(() => {
    const tokens = tokenizeSearch(query);
    return options.filter((o) => matchesAllTokens([o.label, o.value], tokens));
  }, [options, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={testId}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="h-8 min-w-[200px] max-w-[260px] justify-between gap-2 px-2.5 text-xs font-normal"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {selected?.icon != null && (
                <span className="flex shrink-0 items-center justify-center" aria-hidden>
                  {selected.icon}
                </span>
              )}
              <span className="truncate text-left">{selected?.label ?? value}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        }
      />
      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={4}
        className="w-[min(92vw,380px)] p-0 shadow-lg"
      >
        <TooltipProvider delay={200}>
          <div
            role="dialog"
            aria-label="Choose provider"
            className="flex h-[min(340px,42vh)] overflow-hidden rounded-lg border border-border bg-popover"
          >
            <nav
              className={cn(
                LEFT_RAIL_WIDTH_CLASS,
                "flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-muted/15 py-1",
              )}
              aria-label="Providers"
            >
              {options.map((opt) => {
                const active = opt.value === value;
                const tip =
                  opt.title ??
                  (opt.disabled ? `${opt.label} is unavailable.` : opt.label);
                const railBtn = (
                  <button
                    type="button"
                    disabled={opt.disabled}
                    data-disabled={opt.disabled ? "" : undefined}
                    data-testid={`settings-provider-rail-${opt.value || "auto"}`}
                    aria-current={active ? "true" : undefined}
                    aria-label={
                      opt.disabled && opt.title ? `${opt.label}: ${opt.title}` : opt.label
                    }
                    onClick={() => {
                      if (opt.disabled) return;
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors",
                      active && !opt.disabled && "bg-accent text-foreground shadow-sm",
                      !active && !opt.disabled && "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                      opt.disabled && "cursor-not-allowed opacity-45",
                    )}
                  >
                    {opt.icon ?? (
                      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                        {opt.label.slice(0, 2)}
                      </span>
                    )}
                  </button>
                );

                return (
                  <Tooltip key={opt.value || "__auto"}>
                    <TooltipTrigger render={railBtn} />
                    <TooltipContent side="right">{tip}</TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>

            <Command shouldFilter={false} className="min-w-0 flex-1 rounded-none border-0">
              <CommandInput
                placeholder="Search providers…"
                value={query}
                onValueChange={setQuery}
                aria-label="Search providers"
              />
              <CommandList>
                <CommandEmpty>No matches.</CommandEmpty>
                <CommandGroup>
                  {filtered.map((opt) => (
                    <CommandItem
                      key={opt.value || "__auto"}
                      value={opt.value === "" ? EMPTY_PROVIDER_CMDK : opt.value}
                      disabled={opt.disabled}
                      keywords={[opt.label, opt.value].filter(Boolean)}
                      onSelect={() => {
                        if (opt.disabled) return;
                        onChange(opt.value);
                        setOpen(false);
                      }}
                      className="text-xs"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {opt.icon != null && (
                          <span className="flex shrink-0" aria-hidden>
                            {opt.icon}
                          </span>
                        )}
                        <span className="truncate">{opt.label}</span>
                      </span>
                      {value === opt.value && <Check className="size-3.5 shrink-0" aria-hidden />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        </TooltipProvider>
      </PopoverContent>
    </Popover>
  );
}
