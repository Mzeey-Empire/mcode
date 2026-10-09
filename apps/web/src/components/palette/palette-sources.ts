import { FolderIcon, type LucideIcon } from "lucide-react";

/** A place a new project can come from. */
export interface PaletteSource {
  readonly id: string;
  readonly title: string;
  /** One word for the source where space is short, such as the project chooser's Add project row. */
  readonly shortTitle: string;
  readonly subtitle: string;
  readonly icon: LucideIcon;
  /** The query that starts this source's flow. */
  readonly query: string;
}

/**
 * Every built source, in the order the palette's Sources view lists them. Only sources that can finish
 * adding a project belong here, so an unbuilt source is absent rather than dead.
 */
export const PALETTE_SOURCES: readonly PaletteSource[] = [
  {
    id: "local-folder",
    title: "Local folder",
    shortTitle: "Folder",
    subtitle: "Add a folder on this computer",
    icon: FolderIcon,
    query: "~/",
  },
];
