import { useRef, useEffect } from "react";
import { useSidebarSearchStore } from "@/stores/sidebarSearchStore";
import { ThreadFilterDropdown } from "./ThreadFilterDropdown";
import { Search, X, Loader2 } from "lucide-react";

/** Dismissible filter chip. */
function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-primary/15 bg-primary/8 px-1.5 py-px font-mono text-[9px] tracking-[0.04em] text-primary/60">
      {label}
      <button
        className="cursor-pointer text-primary/30 transition-colors hover:text-primary/60"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
      >
        <X size={8} />
      </button>
    </span>
  );
}

/** Inset tray search input with filter icon and dismissible chip row. */
export function ThreadSearchBar({ providers }: { providers: string[] }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useSidebarSearchStore((s) => s.query);
  const setQuery = useSidebarSearchStore((s) => s.setQuery);
  const clearAll = useSidebarSearchStore((s) => s.clearAll);
  const isSearching = useSidebarSearchStore((s) => s.isSearching);
  const filters = useSidebarSearchStore((s) => s.filters);
  const toggleFilter = useSidebarSearchStore((s) => s.toggleFilter);
  const clearFilters = useSidebarSearchStore((s) => s.clearFilters);

  const hasFilters = filters.status.length > 0 || filters.provider.length > 0;

  // Ctrl+Shift+F / Cmd+Shift+F focuses the search input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (query) {
        setQuery("");
      } else {
        inputRef.current?.blur();
      }
    }
  };

  return (
    <div className="px-1.5 pb-0.5 pt-1.5">
      <div className="relative">
        <Search
          size={12}
          className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 transition-colors ${
            query ? "text-primary/35" : "text-muted-foreground/15"
          }`}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search threads..."
          className="w-full rounded-[5px] border-none bg-black/25 py-[5px] pl-7 pr-16 text-[11px] text-foreground shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] outline-none placeholder:text-muted-foreground/18 focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.4),0_0_0_1px_rgba(var(--color-primary)/0.12)]"
          data-testid="sidebar-search-input"
        />
        {isSearching && (
          <Loader2
            size={10}
            className="absolute right-8 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground/30"
          />
        )}
        {query && !isSearching && (
          <button
            className="absolute right-8 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted-foreground/25 transition-colors hover:text-muted-foreground/50"
            onClick={() => clearAll()}
            aria-label="Clear search"
          >
            <X size={10} />
          </button>
        )}
        <ThreadFilterDropdown providers={providers} />
      </div>

      {hasFilters && (
        <div className="mt-1 flex flex-wrap items-center gap-1 px-0.5" data-testid="filter-chip-row">
          {filters.status.map((s) => (
            <FilterChip key={s} label={s} onRemove={() => toggleFilter("status", s)} />
          ))}
          {filters.provider.map((p) => (
            <FilterChip key={p} label={p} onRemove={() => toggleFilter("provider", p)} />
          ))}
          <button
            className="cursor-pointer font-mono text-[8px] tracking-[0.06em] text-muted-foreground/35 transition-colors hover:text-muted-foreground/60"
            onClick={clearFilters}
          >
            clear
          </button>
        </div>
      )}
    </div>
  );
}
