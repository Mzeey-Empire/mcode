import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CheckIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import { SegmentedControl } from "./segmented-control";
import { Spinner } from "./spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Width and padding for a surface that hosts a {@link Picker}, so every host matches Paper's 320px panel. */
export const PICKER_PANEL_CLASS = "w-[min(92vw,32rem)] p-2";

/** What a picker row shows. Rows list a name, an optional muted tag, and a check when selected. */
export interface PickerRow {
  /** Stable identity, compared with `selectedKey`. */
  readonly key: string;
  readonly name: string;
  /** Draws the name in the mono face, for branch names, ids and paths. */
  readonly mono?: boolean;
  /** Short muted detail on the right, such as a group or a source. */
  readonly tag?: string;
  /** Keeps the row listed and dimmed but not choosable. */
  readonly disabled?: boolean;
  /** Why a disabled row is unavailable, shown on hover and read as the row's description. */
  readonly disabledReason?: string;
}

/** One picker tab, drawn as a segment above the list. */
export interface PickerTab {
  readonly id: string;
  readonly label: string;
}

/** Where the list's data stands. A failure carries a title and the raw error for the detail line. */
export type PickerStatus = "ready" | "loading" | { readonly failed: string; readonly detail?: string };

/** Props for {@link Picker}. The parent owns the query, the data and paging; the picker owns keyboard and scroll. */
export interface PickerProps<T> {
  readonly tabs?: readonly PickerTab[];
  readonly activeTab?: string;
  readonly onTabChange?: (id: string) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly searchPlaceholder?: string;
  readonly items: readonly T[];
  /** Size of the full result set. `null` while unknown, which hides the "Showing N of M" line. */
  readonly total: number | null;
  /** Asks for the next page. Called once per page when the list nears its end. */
  readonly onLoadMore?: () => void;
  readonly status: PickerStatus;
  /** Re-runs the failed request from the failure state's Retry button. */
  readonly onRetry?: () => void;
  readonly selectedKey?: string;
  readonly renderItem: (item: T) => PickerRow;
  /** Offers another tab when the query matches nothing here, e.g. "matches in Pull requests". */
  readonly emptySwitch?: { readonly tabId: string; readonly label: string };
  /** Content under the list, set off by a divider, such as a toggle row. */
  readonly footer?: ReactNode;
  readonly onSelect: (item: T) => void;
}

/** Rows remaining below the viewport when the next page is requested. */
const LOAD_MORE_ROWS = 4;
/** A 32px row plus the 1px gap between rows. */
const ROW_PITCH_PX = 33;
const ARROW_STEPS: Partial<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1 };

interface ListRow<T> {
  readonly item: T;
  readonly row: PickerRow;
}

/**
 * Paper's searchable picker (03b): a search field, optional segmented tabs, a five-row list with
 * scroll fades, and a count footer. It renders the panel body only, so callers choose the surface
 * (popover, dialog or inline); put the search field first so the host's initial focus lands on it.
 * Focus stays in the search field; the arrow keys move a highlight through the listbox via
 * `aria-activedescendant`, and Enter picks the highlighted row.
 */
export function Picker<T>(props: PickerProps<T>) {
  const { query, onQueryChange, searchPlaceholder = "Search", items, renderItem, selectedKey, status } = props;
  const listId = useId();
  const rows = useMemo<ListRow<T>[]>(() => items.map((item) => ({ item, row: renderItem(item) })), [items, renderItem]);
  const listKey = `${props.activeTab ?? ""}\u0000${query}`;
  // The highlight belongs to one list; a new tab or query starts over from the selection.
  const [highlight, setHighlight] = useState<{ readonly listKey: string; readonly key: string } | null>(null);
  const activeKey = highlight?.listKey === listKey ? highlight.key : null;
  const setActiveKey = (key: string) => setHighlight({ listKey, key });
  const activeIndex = rows.findIndex(({ row }) => row.key === resolveActiveKey(rows, activeKey, selectedKey));
  const loadMore = useLoadMoreOnce(props, listKey);

  const select = (entry: ListRow<T> | undefined) => {
    if (entry && !entry.row.disabled) props.onSelect(entry.item);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter that ends an IME composition commits text, not a row.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      select(rows[activeIndex]);
      return;
    }
    const step = ARROW_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    moveHighlight(nextEnabledRow(rows, activeIndex, step));
  };

  const moveHighlight = (next: number) => {
    const key = rows[next]?.row.key;
    if (key === undefined) return;
    setActiveKey(key);
    // Only keyboard moves scroll; hover highlights must never move the list under the pointer.
    document.getElementById(optionId(listId, next))?.scrollIntoView?.({ block: "nearest" });
    if (next >= rows.length - LOAD_MORE_ROWS) loadMore();
  };

  const hasRows = rows.length > 0;
  return (
    <div data-slot="picker" className="flex min-w-0 flex-col">
      <div className="flex h-control-compact items-center gap-2 px-2">
        <SearchIcon aria-hidden className="size-[1.4rem] shrink-0 text-muted" strokeWidth={1.5} />
        <input
          role="combobox"
          aria-expanded={hasRows}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex !== -1 ? optionId(listId, activeIndex) : undefined}
          aria-label={searchPlaceholder}
          placeholder={searchPlaceholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 bg-transparent text-body-small text-ink outline-none placeholder:text-muted"
        />
      </div>
      <PickerTabs tabs={props.tabs} activeTab={props.activeTab} onTabChange={props.onTabChange} />
      {hasRows ? (
        <PickerList
          listId={listId}
          listKey={listKey}
          rows={rows}
          activeIndex={activeIndex}
          selectedKey={selectedKey}
          loading={status === "loading"}
          onHighlight={setActiveKey}
          onPick={select}
          onNearEnd={loadMore}
        />
      ) : null}
      {/* A failed page keeps the rows already loaded; only an empty list gives way to the status. */}
      {typeof status === "object" ? (
        <PickerFailure status={status} onRetry={props.onRetry} />
      ) : hasRows ? null : (
        <PickerEmptyState {...props} listId={listId} />
      )}
      <PickerFooter loaded={items.length} total={props.total} footer={props.footer} />
    </div>
  );
}

function PickerTabs({ tabs, activeTab, onTabChange }: Pick<PickerProps<unknown>, "tabs" | "activeTab" | "onTabChange">) {
  if (!tabs || tabs.length === 0) return null;
  return (
    <div className="px-0.5 pb-1.5">
      <SegmentedControl
        size="compact"
        fill
        aria-label="Picker tabs"
        options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
        value={activeTab ?? ""}
        onChange={(id) => onTabChange?.(id)}
      />
    </div>
  );
}

function PickerFooter({ loaded, total, footer }: { readonly loaded: number; readonly total: number | null; readonly footer?: ReactNode }) {
  return (
    <>
      {total !== null ? (
        <p className="px-2 pt-1 pb-2 text-caption text-muted">
          Showing {loaded} of {total}
        </p>
      ) : null}
      {footer ? <div className="border-t border-border px-2 pt-2 pb-1">{footer}</div> : null}
    </>
  );
}

/** The highlighted row survives appended pages; otherwise it falls back to the selection, then the first enabled row. */
function resolveActiveKey<T>(rows: readonly ListRow<T>[], activeKey: string | null, selectedKey?: string): string | null {
  const isEnabled = (key: string | null | undefined) => rows.some(({ row }) => row.key === key && !row.disabled);
  if (isEnabled(activeKey)) return activeKey;
  if (isEnabled(selectedKey)) return selectedKey ?? null;
  return rows.find(({ row }) => !row.disabled)?.row.key ?? null;
}

/** Next enabled row from `from` in direction `step`, stopping at the ends, or -1 when there is none. */
function nextEnabledRow<T>(rows: readonly ListRow<T>[], from: number, step: 1 | -1): number {
  for (let index = from + step; index >= 0 && index < rows.length; index += step) {
    if (!rows[index]?.row.disabled) return index;
  }
  return -1;
}

function optionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * Wraps `onLoadMore` so it fires at most once per page. A page is identified by the list (tab and
 * query) plus the item count, so a fresh list of the same length still gets its second page.
 */
function useLoadMoreOnce<T>({ onLoadMore, items, total, status }: PickerProps<T>, listKey: string): () => void {
  const requestedFor = useRef<string | null>(null);
  // A failed page must be askable again after Retry, even though the item count has not moved.
  const failed = typeof status === "object";
  useEffect(() => {
    if (failed) requestedFor.current = null;
  }, [failed]);
  return useCallback(() => {
    const page = `${listKey}\u0000${items.length}`;
    const exhausted = total !== null && items.length >= total;
    if (!onLoadMore || status !== "ready" || exhausted || requestedFor.current === page) return;
    requestedFor.current = page;
    onLoadMore();
  }, [onLoadMore, status, total, items.length, listKey]);
}

interface PickerListProps<T> {
  readonly listId: string;
  /** Changes when the tab or query starts a new list, which scrolls back to the top. */
  readonly listKey: string;
  readonly rows: readonly ListRow<T>[];
  readonly activeIndex: number;
  readonly selectedKey?: string;
  readonly loading: boolean;
  readonly onHighlight: (key: string) => void;
  readonly onPick: (entry: ListRow<T>) => void;
  readonly onNearEnd: () => void;
}

function PickerList<T>(props: PickerListProps<T>) {
  const { listId, listKey, rows, activeIndex, selectedKey, onHighlight, onPick, onNearEnd } = props;
  const listRef = useRef<HTMLUListElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    setAtTop(list.scrollTop <= 0);
    setAtEnd(remaining <= 1);
    if (remaining <= LOAD_MORE_ROWS * ROW_PITCH_PX) onNearEnd();
  }, [onNearEnd]);

  // Declared before the measure effect so a new list is measured from the top, not the old offset.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [listKey]);
  useLayoutEffect(measure, [measure, rows.length]);

  // Opening on a selection far down the list brings it into view once; later moves scroll from the keyboard handler.
  const initialActiveIndex = useRef(activeIndex);
  useEffect(() => {
    if (initialActiveIndex.current === -1) return;
    document.getElementById(optionId(listId, initialActiveIndex.current))?.scrollIntoView?.({ block: "nearest" });
  }, [listId]);

  return (
    <div className="relative">
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        onScroll={measure}
        className="flex max-h-[17.2rem] flex-col gap-px overflow-y-auto pt-2"
      >
        {rows.map((entry, index) => (
          <PickerOption
            key={entry.row.key}
            id={optionId(listId, index)}
            row={entry.row}
            active={index === activeIndex}
            selected={entry.row.key === selectedKey}
            onHighlight={() => onHighlight(entry.row.key)}
            onPick={() => onPick(entry)}
          />
        ))}
        {props.loading ? (
          <li role="presentation" className="flex h-8 shrink-0 items-center px-2">
            <Spinner size={12} aria-label="Loading" />
          </li>
        ) : null}
      </ul>
      {/* The fades say there is more to scroll, so each shows only while its edge is out of view. */}
      {atTop ? null : (
        <div aria-hidden data-slot="picker-fade-top" className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-panel to-transparent" />
      )}
      {atEnd ? null : (
        <div aria-hidden data-slot="picker-fade-bottom" className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-panel to-transparent" />
      )}
    </div>
  );
}

interface PickerOptionProps {
  readonly id: string;
  readonly row: PickerRow;
  readonly active: boolean;
  readonly selected: boolean;
  readonly onHighlight: () => void;
  readonly onPick: () => void;
}

/** Wraps a disabled row in the reason tooltip, matching the Menu's disabled rows. */
function PickerOption(props: PickerOptionProps) {
  const reason = props.row.disabled ? props.row.disabledReason : undefined;
  if (!reason) return <PickerOptionItem {...props} reason={undefined} />;
  return (
    <Tooltip>
      <TooltipTrigger render={<PickerOptionItem {...props} reason={reason} />} />
      <TooltipContent side="right">{reason}</TooltipContent>
    </Tooltip>
  );
}

function PickerOptionItem({ id, row, active, selected, onHighlight, onPick, reason, ...triggerProps }: PickerOptionProps & { readonly reason: string | undefined }) {
  return (
    <li
      {...triggerProps}
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={row.disabled || undefined}
      aria-describedby={reason ? `${id}-reason` : undefined}
      data-active={active || undefined}
      // Keeps focus in the search field so typing and arrow keys keep working after a click.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={row.disabled || active ? undefined : onHighlight}
      onClick={row.disabled ? undefined : onPick}
      className={cn(
        "flex h-8 shrink-0 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-body-small text-ink data-active:bg-hover",
        row.disabled && "cursor-default opacity-50",
      )}
    >
      <PickerOptionContent row={row} selected={selected} />
      {reason ? <span id={`${id}-reason`} hidden>{reason}</span> : null}
    </li>
  );
}

function PickerOptionContent({ row, selected }: { readonly row: PickerRow; readonly selected: boolean }) {
  return (
    <>
      <span className={cn("min-w-0 flex-1 text-fade", row.mono && "font-mono text-caption")}>{row.name}</span>
      {row.tag ? <span className="shrink-0 text-caption text-muted">{row.tag}</span> : null}
      <span aria-hidden className="flex size-[1.4rem] shrink-0 items-center justify-center">
        {selected ? <CheckIcon className="size-[1.4rem] text-ink" strokeWidth={1.5} /> : null}
      </span>
    </>
  );
}

function PickerFailure({ status, onRetry }: { readonly status: { readonly failed: string; readonly detail?: string }; readonly onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-1 px-2 py-2">
      <p className="text-label text-ink">{status.failed}</p>
      {status.detail ? <p className="font-mono text-caption break-all text-muted">{status.detail}</p> : null}
      {onRetry ? (
        <Button variant="ghost" size="compact" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** What replaces an empty list: a spinner while loading, otherwise the no-match line. */
function PickerEmptyState<T>({ status, query, emptySwitch, onTabChange, listId }: PickerProps<T> & { readonly listId: string }) {
  if (status === "loading") {
    return (
      <div id={listId} className="flex h-8 items-center px-2">
        <Spinner size={12} aria-label="Loading" />
      </div>
    );
  }
  return (
    <div id={listId} className="flex flex-col items-start gap-1 px-2 py-2">
      <p className="text-label text-ink">{query ? `Nothing matches “${query}”` : "Nothing to show"}</p>
      {query && emptySwitch ? (
        <Button variant="ghost" size="compact" onClick={() => onTabChange?.(emptySwitch.tabId)}>
          Show {emptySwitch.label}
        </Button>
      ) : null}
    </div>
  );
}
