import { CommandList, CommandEmpty } from "@/components/ui/command";

/** Props for AddProjectView. */
interface Props {
  /** Initial path to browse from. */
  path: string;
}

/**
 * Palette subview for adding a new project via folder-browse-as-search.
 * Full implementation in Task 7. This placeholder keeps the palette
 * shell compiling while the filesystem.browse RPC is built.
 */
export function AddProjectView({ path: _path }: Props) {
  return (
    <CommandList>
      <CommandEmpty>Filesystem browser coming soon.</CommandEmpty>
    </CommandList>
  );
}
