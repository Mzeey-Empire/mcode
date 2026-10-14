import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { cn } from "@/lib/utils";
import type { FindOptions } from "./find-in-file";
import type { FindInFile } from "./useFindInFile";

const OPTION_TOGGLES: readonly { readonly option: keyof FindOptions; readonly label: string; readonly glyph: string; readonly mono: boolean }[] = [
  { option: "caseSensitive", label: "Match case", glyph: "Aa", mono: false },
  { option: "wholeWord", label: "Match whole word", glyph: "ab", mono: true },
  { option: "regex", label: "Use regular expression", glyph: ".*", mono: true },
];

/** Count readout beside the field: "3 of 12", "No results", or the pattern error. */
export function findCountLabel({ result, index }: Pick<FindInFile, "result" | "index">): string {
  if (result.status === "idle") return "";
  if (result.status === "invalid") return "Invalid pattern";
  const count = result.matches.length;
  if (count === 0) return "No results";
  return `${index + 1} of ${count}${result.capped ? "+" : ""}`;
}

export interface FindInFileBarProps {
  readonly find: FindInFile;
  readonly onClose: () => void;
}

/**
 * Row 3 of the Files header: the find field with its count and option toggles,
 * then previous, next and close. Enter and Shift+Enter step, Esc closes.
 */
export function FindInFileBar({ find, onClose }: FindInFileBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const onBarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };
  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    find.step(event.shiftKey ? -1 : 1);
  };

  const invalid = find.result.status === "invalid";
  return (
    <PanelHeaderSlot slot="row3">
      <div data-files-tool="" data-testid="find-in-file-bar" onKeyDown={onBarKeyDown} className="flex h-10 min-w-0 flex-1 items-center gap-1.5 px-2">
        <label
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[18px] bg-selected pl-3 pr-1 shadow-[inset_0_0_0_1px_var(--color-focus)]",
            invalid && "shadow-[inset_0_0_0_1px_var(--color-destructive)]",
          )}
        >
          <input
            ref={inputRef}
            data-find-input=""
            aria-label="Find"
            aria-invalid={invalid || undefined}
            placeholder="Find"
            spellCheck={false}
            value={find.query}
            onChange={(event) => find.setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            className="min-w-0 flex-1 bg-transparent text-body-small text-ink outline-none placeholder:text-muted"
          />
          <span role="status" className={cn("shrink-0 font-mono text-caption", invalid ? "text-destructive" : "text-muted")}>
            {findCountLabel(find)}
          </span>
          {OPTION_TOGGLES.map((toggle) => (
            <button
              key={toggle.option}
              type="button"
              aria-label={toggle.label}
              aria-pressed={find.options[toggle.option]}
              onClick={() => find.toggleOption(toggle.option)}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-caption text-muted hover:bg-hover aria-pressed:bg-control-border aria-pressed:text-ink",
                toggle.mono ? "font-mono" : "font-semibold",
              )}
            >
              {toggle.glyph}
            </button>
          ))}
        </label>
        <IconButton shape="round" aria-label="Previous match" onClick={() => find.step(-1)}>
          <ChevronUp />
        </IconButton>
        <IconButton shape="round" aria-label="Next match" onClick={() => find.step(1)}>
          <ChevronDown />
        </IconButton>
        <IconButton shape="round" aria-label="Close find" onClick={onClose}>
          <X />
        </IconButton>
      </div>
    </PanelHeaderSlot>
  );
}
