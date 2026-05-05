import { useState } from "react";
import { useSidebarSearchStore, type ThreadSortField } from "@/stores/sidebarSearchStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Check } from "lucide-react";

const SORT_OPTIONS: { field: ThreadSortField; label: string }[] = [
  { field: "updated_at", label: "Recent activity" },
  { field: "created_at", label: "Created date" },
  { field: "title", label: "Name (A-Z)" },
];

const SORT_LABELS: Record<ThreadSortField, string> = {
  updated_at: "recent",
  created_at: "created",
  title: "name",
};

/** Direction label shown at the bottom of the sort dropdown. */
function directionLabel(field: ThreadSortField, dir: "asc" | "desc"): string {
  if (field === "title") return dir === "asc" ? "↑ A → Z" : "↓ Z → A";
  return dir === "desc" ? "↓ Newest first" : "↑ Oldest first";
}

/** Persistent sort label + dropdown for the sidebar PROJECTS header. */
export function ThreadSortControl() {
  const [open, setOpen] = useState(false);
  const sortField = useSidebarSearchStore((s) => s.sortField);
  const sortDirection = useSidebarSearchStore((s) => s.sortDirection);
  const setSortField = useSidebarSearchStore((s) => s.setSortField);
  const toggleSortDirection = useSidebarSearchStore((s) => s.toggleSortDirection);

  const arrow = sortDirection === "asc" ? "↑" : "↓";
  const isNonDefault = sortField !== "updated_at" || sortDirection !== "desc";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            className={`inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 font-mono text-[9px] tracking-[0.06em] transition-colors hover:bg-accent/40 ${
              isNonDefault ? "text-primary/70" : "text-primary/40"
            }`}
            aria-label="Sort threads"
          >
            {SORT_LABELS[sortField]} {arrow}
          </button>
        }
      />
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={4}
        className="w-44 rounded-md border border-border bg-popover p-1 shadow-lg"
      >
        <div className="px-2 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground/30">
          Sort threads by
        </div>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.field}
            className={`flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-[11px] transition-colors hover:bg-accent/40 ${
              sortField === opt.field ? "text-primary" : "text-muted-foreground"
            }`}
            onClick={() => {
              setSortField(opt.field);
              setOpen(false);
            }}
          >
            {opt.label}
            {sortField === opt.field && <Check size={11} className="text-primary" />}
          </button>
        ))}
        <div className="mx-1 my-1 h-px bg-border/50" />
        <button
          className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent/40"
          onClick={toggleSortDirection}
        >
          {directionLabel(sortField, sortDirection)}
          <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
            click to flip
          </span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
