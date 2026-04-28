import { CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import type { View } from "@/stores/commandPaletteStore";

/** Props for SelectionListView — the view data is the full selectionList View object. */
interface Props {
  view: Extract<View, { kind: "selectionList" }>;
}

/**
 * Generic "pick one from a list" palette subview.
 * Renders a flat list of items and calls onPick with the selected id.
 */
export function SelectionListView({ view }: Props) {
  return (
    <CommandList>
      <CommandEmpty>No options available.</CommandEmpty>
      <CommandGroup heading={view.title}>
        {view.items.map((item) => (
          <CommandItem
            key={item.id}
            value={item.id}
            onSelect={() => view.onPick(item.id)}
            className="px-3 py-2 text-[13px]"
          >
            {item.title}
          </CommandItem>
        ))}
      </CommandGroup>
    </CommandList>
  );
}
