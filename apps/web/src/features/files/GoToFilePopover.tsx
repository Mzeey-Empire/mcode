import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Search } from "lucide-react";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { cn } from "@/lib/utils";
import { rankFilePaths, type RankedFilePath } from "./rank-file-path";

/** Props for {@link GoToFilePopover}. */
export interface GoToFilePopoverProps {
  readonly paths: readonly string[];
  /** `beside` is true for Ctrl/Cmd+Enter: open after the active tab without switching. */
  readonly onPick: (path: string, beside: boolean) => void;
  readonly onClose: () => void;
}

/**
 * Go to file: fuzzy search over the scope's paths. Enter opens and activates,
 * Ctrl/Cmd+Enter opens beside the active tab, Esc closes.
 */
export function GoToFilePopover({ paths, onPick, onClose }: GoToFilePopoverProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => rankFilePaths(paths, query), [paths, query]);
  const active = results[Math.min(activeIndex, results.length - 1)];

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const handled = handleKey(event, results.length, setActiveIndex, onClose);
    if (handled) return;
    if (event.key !== "Enter" || !active) return;
    event.preventDefault();
    onPick(active.path, event.ctrlKey || event.metaKey);
  };

  return (
    <>
      <button type="button" aria-label="Close Go to file" tabIndex={-1} className="absolute inset-0 z-(--layer-dropdown) cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Go to file"
        className="absolute left-1/2 top-2 z-(--layer-dropdown) w-[min(380px,calc(100%-16px))] -translate-x-1/2 rounded-[14px] border border-border bg-panel p-1.5 shadow-popover"
      >
        <label className="flex h-9 items-center gap-2 border-b border-border px-2">
          <Search aria-hidden size={14} className="shrink-0 text-muted" />
          <input
            autoFocus
            aria-label="Go to file"
            placeholder="Go to file"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
          />
        </label>
        <ul role="listbox" aria-label="Files" className="mt-1.5 max-h-80 overflow-y-auto">
          {results.map((result, index) => (
            <ResultRow
              key={result.path}
              result={result}
              active={result === active}
              onHover={() => setActiveIndex(index)}
              onPick={(beside) => onPick(result.path, beside)}
            />
          ))}
        </ul>
        {results.length === 0 ? <p className="px-2 py-1.5 text-caption text-muted">No matching files</p> : null}
      </div>
    </>
  );
}

function handleKey(
  event: KeyboardEvent<HTMLInputElement>,
  count: number,
  setActiveIndex: (update: (index: number) => number) => void,
  onClose: () => void,
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    // The panel and app also listen for Escape; Go to file owns this press.
    event.stopPropagation();
    onClose();
    return true;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  setActiveIndex((index) => (count === 0 ? 0 : (index + step + count) % count));
  return true;
}

function ResultRow({
  result,
  active,
  onHover,
  onPick,
}: {
  readonly result: RankedFilePath;
  readonly active: boolean;
  readonly onHover: () => void;
  readonly onPick: (beside: boolean) => void;
}) {
  const nameStart = result.path.lastIndexOf("/") + 1;
  const folder = nameStart > 0 ? result.path.slice(0, nameStart - 1) : "";
  return (
    <li
      role="option"
      aria-selected={active}
      data-path={result.path}
      className={cn("flex cursor-default items-center gap-2 rounded-lg px-2 py-1", active && "bg-hover")}
      onMouseMove={onHover}
      onClick={(event) => onPick(event.ctrlKey || event.metaKey)}
    >
      <FileTypeIcon filePath={result.path} size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="text-fade block text-sm leading-5 text-ink/75">
          <Highlighted text={result.path} from={nameStart} to={result.path.length} matches={result.matches} />
        </span>
        {folder ? (
          <span className="text-fade block text-xs leading-4 text-muted">
            <Highlighted text={result.path} from={0} to={folder.length} matches={result.matches} />
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** Renders `text[from, to)` with matched letters in ink so the user sees why a row matched. */
function Highlighted({ text, from, to, matches }: { readonly text: string; readonly from: number; readonly to: number; readonly matches: readonly number[] }) {
  const matched = new Set(matches);
  const parts: ReactNode[] = [];
  let runStart = from;
  for (let index = from; index <= to; index += 1) {
    const boundary = index === to || matched.has(index) !== matched.has(runStart);
    if (!boundary) continue;
    const slice = text.slice(runStart, index);
    parts.push(matched.has(runStart) ? <mark key={runStart} className="bg-transparent font-medium text-ink">{slice}</mark> : slice);
    runStart = index;
  }
  return <>{parts}</>;
}
