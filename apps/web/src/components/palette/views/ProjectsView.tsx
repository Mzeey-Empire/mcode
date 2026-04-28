import { CommandList, CommandEmpty } from "@/components/ui/command";

/**
 * Palette subview for browsing and searching recent/pinned projects.
 * Full implementation in Task 16. This placeholder keeps the palette
 * shell compiling while the project selector data layer is built.
 */
export function ProjectsView() {
  return (
    <CommandList>
      <CommandEmpty>No projects yet.</CommandEmpty>
    </CommandList>
  );
}
