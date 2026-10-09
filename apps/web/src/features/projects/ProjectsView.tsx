import { useEffect, useMemo } from "react";
import { CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "./state/workspaceStore";
import { useProjectSelectorStore } from "./state/projectSelectorStore";
import { ProjectRow } from "./ProjectRow";
import { PaletteFooterHints, type PaletteHint } from "@/components/palette/PaletteFooterHints";

const PROJECTS_HINTS: readonly PaletteHint[] = [
  { keys: ["↑", "↓"], label: "Navigate" },
  { keys: ["Enter"], label: "Open" },
  { keys: ["Esc"], label: "Close" },
];

/**
 * Palette subview listing pinned and recently-opened workspaces.
 * Filters by the palette's active query using simple substring matching on name and path.
 * Uses ProjectRow for each entry so lazy enrichment (branch/status/count) fades in automatically.
 */
export function ProjectsView() {
  const query = useCommandPaletteStore((s) => s.query);
  const close = useCommandPaletteStore((s) => s.close);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const pinWorkspace = useWorkspaceStore((s) => s.pinWorkspace);

  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    return workspaces.filter((w) => {
      if (!q) return true;
      return w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q);
    });
  }, [workspaces, q]);

  const pinned = filtered.filter((w) => w.pinned);
  const recent = filtered.filter((w) => !w.pinned && w.last_opened_at != null);
  // Everything else: known projects the user hasn't opened recently. Keeping these
  // visible (and searchable) means the input promise — "Search projects…" — is honest.
  const others = filtered.filter((w) => !w.pinned && w.last_opened_at == null);

  // Batch enrichment for every visible row: a single RPC for the whole list
  // beats N concurrent ones (one per ProjectRow) on first paint.
  const enrich = useProjectSelectorStore((s) => s.enrich);
  const visibleIds = useMemo(
    () => [...pinned, ...recent, ...others].map((w) => w.id),
    [pinned, recent, others],
  );
  useEffect(() => {
    if (visibleIds.length > 0) enrich(visibleIds);
  }, [visibleIds, enrich]);

  const handleSelect = (id: string) => {
    setActiveWorkspace(id);
    close();
  };

  const handlePin = (id: string, pinned: boolean) => {
    void pinWorkspace(id, pinned);
  };

  const isEmpty = pinned.length === 0 && recent.length === 0 && others.length === 0;

  return (
    <>
      <CommandList className="max-h-96 overflow-y-auto">
        {isEmpty && (
          <CommandEmpty>
            {q ? "No matching projects." : "No projects yet. Add one below."}
          </CommandEmpty>
        )}

        {pinned.length > 0 && (
          <CommandGroup heading="Pinned">
            {pinned.map((w) => (
              // CommandItem makes the row visible to cmdk's keyboard navigator.
              // p-0 removes CommandItem's own padding since ProjectRow has its own layout.
              // w-full/min-w-0: cmdk items shrink-wrap otherwise; fills list width for hit area + selection.
              <CommandItem
                key={w.id}
                value={`${w.name} ${w.path}`}
                onSelect={() => handleSelect(w.id)}
                className="w-full min-w-0 p-0"
              >
                <ProjectRow
                  workspace={w}
                  onSelect={handleSelect}
                  onPin={handlePin}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {recent.length > 0 && (
          <CommandGroup heading="Recent">
            {recent.map((w) => (
              <CommandItem
                key={w.id}
                value={`${w.name} ${w.path}`}
                onSelect={() => handleSelect(w.id)}
                className="w-full min-w-0 p-0"
              >
                <ProjectRow
                  workspace={w}
                  onSelect={handleSelect}
                  onPin={handlePin}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {others.length > 0 && (
          <CommandGroup heading="All projects">
            {others.map((w) => (
              <CommandItem
                key={w.id}
                value={`${w.name} ${w.path}`}
                onSelect={() => handleSelect(w.id)}
                className="w-full min-w-0 p-0"
              >
                <ProjectRow
                  workspace={w}
                  onSelect={handleSelect}
                  onPin={handlePin}
                />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>

      <PaletteFooterHints
        hints={PROJECTS_HINTS}
        trailing={
          <button type="button" className="text-caption text-muted hover:text-ink" onClick={() => setQuery("~/")}>
            Add project
          </button>
        }
      />
    </>
  );
}
