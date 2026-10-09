import { CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { PALETTE_LIST_HINTS, PaletteFooterHints } from "../PaletteFooterHints";
import { PALETTE_SOURCES, type PaletteSource } from "../palette-sources";

function matchesQuery(source: PaletteSource, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return source.title.toLowerCase().includes(needle) || source.subtitle.toLowerCase().includes(needle);
}

/**
 * Lists where a project can be added from. Selecting a source swaps the query for the one that
 * starts its flow, so Local folder browses from the home folder.
 */
export function SourcesView() {
  const query = useCommandPaletteStore((s) => s.query);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const sources = PALETTE_SOURCES.filter((source) => matchesQuery(source, query));

  return (
    <>
      <CommandList className="max-h-80">
        <CommandEmpty>No sources match.</CommandEmpty>
        {sources.length > 0 ? (
          <CommandGroup heading="Sources">
            {sources.map((source) => (
              <CommandItem
                key={source.id}
                value={source.id}
                onSelect={() => setQuery(source.query)}
              >
                <source.icon aria-hidden className="size-[1.4rem] shrink-0 text-ink" strokeWidth={1.5} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-fade text-label text-ink">{source.title}</span>
                  <span className="text-fade text-caption text-muted">{source.subtitle}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
      <PaletteFooterHints hints={PALETTE_LIST_HINTS} />
    </>
  );
}
