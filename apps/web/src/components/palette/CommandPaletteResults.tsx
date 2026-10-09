import {
  CommandGroup,
  CommandItem,
  CommandList,
  CommandEmpty,
} from "@/components/ui/command";
import type { PaletteGroup } from "./CommandPalette.logic";

/** Props for CommandPaletteResults. */
interface Props {
  /** Filtered, ranked groups to render. */
  groups: PaletteGroup[];
  /** Called when the user selects an item. Receives the item's value. */
  onSelect: (value: string) => void;
}

/**
 * Renders ranked palette groups using cmdk Command.Group and Command.Item.
 */
export function CommandPaletteResults({ groups, onSelect }: Props) {
  return (
    <CommandList className="max-h-80 overflow-y-auto">
      <CommandEmpty>No results found.</CommandEmpty>
      {groups.map((group) => (
        <CommandGroup key={group.heading} heading={group.heading}>
          {group.items.map((item) => (
            <CommandItem
              key={item.value}
              value={item.value}
              keywords={item.searchTerms}
              onSelect={() => onSelect(item.value)}
              className="text-body-small"
            >
              <span className="flex-1 text-fade">{item.title}</span>
              {item.description && (
                <span className="ml-2 text-fade font-mono text-caption text-muted/60">
                  {item.description}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      ))}
    </CommandList>
  );
}
