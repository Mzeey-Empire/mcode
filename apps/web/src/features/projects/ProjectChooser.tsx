import { useMemo, useState, type ReactElement } from "react";
import { ChevronRightIcon, InboxIcon, PlusIcon } from "lucide-react";
import type { Workspace } from "@mcode/contracts/models/workspace";
import { PALETTE_SOURCES } from "@/components/palette/palette-sources";
import { Picker, type PickerRow } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useProjectWorkspaces } from "./state/workspace-selectors";
import { selectNewThreadIsNoProject, useWorkspaceStore } from "./state/workspaceStore";
import { ProjectIcon } from "./icons/ProjectIcon";

/** Props for {@link ProjectChooser}. */
export interface ProjectChooserProps {
  /** The control that opens the chooser, such as the new-thread heading's project slot. */
  readonly trigger: ReactElement;
  /** Tooltip shown on the trigger. */
  readonly triggerTooltip?: string;
  /** Which side of the trigger the chooser opens on. */
  readonly side?: "top" | "bottom";
}

const SOURCES_META = PALETTE_SOURCES.map((source) => source.shortTitle).join(", ");

type ChooserItem =
  | { readonly kind: "no-project" }
  | { readonly kind: "project"; readonly workspace: Workspace };

const NO_PROJECT_ITEM: ChooserItem = { kind: "no-project" };
const NO_PROJECT_LABEL = "No project";
const NO_PROJECT_ROW_KEY = "no-project";

/** Starts a new-thread composer in the selected target. Add project opens the palette's Sources view. */
export function ProjectChooser({ trigger, triggerTooltip, side = "bottom" }: ProjectChooserProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const projects = useProjectWorkspaces();
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const onNoProject = useWorkspaceStore(selectNewThreadIsNoProject);
  const beginNewThread = useWorkspaceStore((state) => state.beginNewThread);
  const beginNoProjectThread = useWorkspaceStore((state) => state.beginNoProjectThread);

  const setOpenAndResetQuery = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const chooseItem = (item: ChooserItem) => {
    if (item.kind === "no-project") beginNoProjectThread();
    else beginNewThread(item.workspace.id);
    setOpenAndResetQuery(false);
  };

  const addProject = () => {
    setOpenAndResetQuery(false);
    // Opened after the popover closes, so its focus return to the trigger cannot pull focus out of the palette.
    queueMicrotask(() => useCommandPaletteStore.getState().open({ intent: "addProject" }));
  };

  const popoverTrigger = <PopoverTrigger render={trigger} />;
  return (
    <Popover open={open} onOpenChange={setOpenAndResetQuery}>
      {triggerTooltip ? (
        <Tooltip>
          <TooltipTrigger render={popoverTrigger} />
          <TooltipContent>{triggerTooltip}</TooltipContent>
        </Tooltip>
      ) : popoverTrigger}
      <PopoverContent
        role="dialog"
        aria-label="Choose project"
        side={side}
        align="start"
        sideOffset={12}
        className="flex w-[min(92vw,30rem)] flex-col gap-px p-[0.6rem]"
      >
        <ChooserList
          projects={projects}
          selectedKey={onNoProject ? NO_PROJECT_ROW_KEY : activeWorkspaceId ?? undefined}
          query={query}
          onQueryChange={setQuery}
          onSelect={chooseItem}
        />
        <div aria-hidden className="mx-0.5 mb-1 h-px shrink-0 bg-border" />
        <AddProjectRow onClick={addProject} />
      </PopoverContent>
    </Popover>
  );
}

interface ChooserListProps {
  readonly projects: readonly Workspace[];
  readonly selectedKey: string | undefined;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (item: ChooserItem) => void;
}

function ChooserList({ projects, selectedKey, query, onQueryChange, onSelect }: ChooserListProps) {
  const items = useMemo(() => chooserItems(projects, query), [projects, query]);
  return (
    <Picker
      query={query}
      onQueryChange={onQueryChange}
      searchPlaceholder="Search projects"
      items={items}
      total={null}
      status="ready"
      selectedKey={selectedKey}
      renderItem={chooserRow}
      onSelect={onSelect}
    />
  );
}

function chooserRow(item: ChooserItem): PickerRow {
  if (item.kind === "no-project") {
    return { key: NO_PROJECT_ROW_KEY, name: NO_PROJECT_LABEL, icon: <InboxIcon aria-hidden className="size-4" />, group: "no-project" };
  }
  const { workspace } = item;
  return { key: workspace.id, name: workspace.name, icon: <ProjectIcon workspaceId={workspace.id} name={workspace.name} size={16} />, group: "projects" };
}

function chooserItems(projects: readonly Workspace[], query: string): readonly ChooserItem[] {
  const matches = filterProjects(projects, query).map((workspace): ChooserItem => ({ kind: "project", workspace }));
  const needle = query.trim().toLowerCase();
  if (!needle) return [NO_PROJECT_ITEM, ...matches];
  return NO_PROJECT_LABEL.toLowerCase().startsWith(needle) ? [...matches, NO_PROJECT_ITEM] : matches;
}

/** Projects whose name or folder contains the query, ignoring case, in the store's order. */
function filterProjects(workspaces: readonly Workspace[], query: string): readonly Workspace[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return workspaces;
  return workspaces.filter(
    (workspace) => workspace.name.toLowerCase().includes(needle) || workspace.path.toLowerCase().includes(needle),
  );
}

function AddProjectRow({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover active:bg-selected",
        FOCUS_RING_CLASS,
      )}
    >
      <PlusIcon aria-hidden className="size-[1.4rem] shrink-0 text-ink" />
      <span className="min-w-0 flex-1 text-fade text-label text-ink">Add project</span>
      <span className="shrink-0 text-caption text-muted">{SOURCES_META}</span>
      <ChevronRightIcon aria-hidden className="size-[1.2rem] shrink-0 text-muted" />
    </button>
  );
}
