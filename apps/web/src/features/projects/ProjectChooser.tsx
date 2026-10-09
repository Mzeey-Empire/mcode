import { useMemo, useState, type ReactElement } from "react";
import { ChevronRightIcon, FolderIcon, PlusIcon } from "lucide-react";
import type { Workspace } from "@mcode/contracts";
import { PALETTE_SOURCES } from "@/components/palette/palette-sources";
import { Picker, type PickerRow } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "./state/workspaceStore";

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

/**
 * Paper's project chooser (02b): the project list with a check on the active project, or the
 * "No projects yet" state, above an Add project row that opens the palette on Sources.
 * Choosing a project starts a new thread in it.
 */
export function ProjectChooser({ trigger, triggerTooltip, side = "bottom" }: ProjectChooserProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const beginNewThread = useWorkspaceStore((state) => state.beginNewThread);

  const setOpenAndResetQuery = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const chooseProject = (workspace: Workspace) => {
    beginNewThread(workspace.id);
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
        {workspaces.length === 0 ? (
          <NoProjects />
        ) : (
          <ProjectList
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            query={query}
            onQueryChange={setQuery}
            onSelect={chooseProject}
          />
        )}
        <div aria-hidden className="mx-0.5 mb-1 h-px shrink-0 bg-border" />
        <AddProjectRow onClick={addProject} />
      </PopoverContent>
    </Popover>
  );
}

interface ProjectListProps {
  readonly workspaces: readonly Workspace[];
  readonly activeWorkspaceId: string | null;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (workspace: Workspace) => void;
}

function ProjectList({ workspaces, activeWorkspaceId, query, onQueryChange, onSelect }: ProjectListProps) {
  const matches = useMemo(() => filterProjects(workspaces, query), [workspaces, query]);
  return (
    <Picker
      query={query}
      onQueryChange={onQueryChange}
      searchPlaceholder="Search projects"
      items={matches}
      total={null}
      status="ready"
      selectedKey={activeWorkspaceId ?? undefined}
      renderItem={projectRow}
      onSelect={onSelect}
    />
  );
}

function projectRow(workspace: Workspace): PickerRow {
  return { key: workspace.id, name: workspace.name };
}

/** Projects whose name or folder contains the query, ignoring case, in the store's order. */
function filterProjects(workspaces: readonly Workspace[], query: string): readonly Workspace[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return workspaces;
  return workspaces.filter(
    (workspace) => workspace.name.toLowerCase().includes(needle) || workspace.path.toLowerCase().includes(needle),
  );
}

function NoProjects() {
  return (
    <div className="flex flex-col items-center gap-3 px-4 pt-5 pb-4 text-center">
      <span
        aria-hidden
        className="flex size-[3.6rem] shrink-0 items-center justify-center rounded-lg border border-border bg-selected text-muted"
      >
        <FolderIcon className="size-[1.8rem]" strokeWidth={1.5} />
      </span>
      <div className="flex flex-col items-center gap-0.5">
        <p className="text-label text-ink">No projects yet</p>
        <p className="text-caption text-muted">Add a folder to start working in its code.</p>
      </div>
    </div>
  );
}

function AddProjectRow({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover",
        FOCUS_RING_CLASS,
      )}
    >
      <PlusIcon aria-hidden className="size-[1.4rem] shrink-0 text-ink" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 text-fade text-label text-ink">Add project</span>
      <span className="shrink-0 text-caption text-muted">{SOURCES_META}</span>
      <ChevronRightIcon aria-hidden className="size-[1.2rem] shrink-0 text-muted" strokeWidth={1.5} />
    </button>
  );
}
