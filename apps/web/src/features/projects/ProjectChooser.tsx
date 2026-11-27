import { useMemo, useState, type ReactElement } from "react";
import { CheckIcon, ChevronRightIcon, InboxIcon, PlusIcon } from "lucide-react";
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
  readonly pick?: ProjectChooserPick;
}

/**
 * Turns the chooser into a plain project picker: it lists only projects, hands the choice to `onSelect`,
 * and never touches the composer or the Add project palette.
 */
export interface ProjectChooserPick {
  readonly selectedWorkspaceId: string | null;
  /** Called with the chosen project after the chooser closes. */
  readonly onSelect: (workspace: Workspace) => void;
  readonly onOpenChange?: (open: boolean) => void;
  readonly disabled?: boolean;
  /**
   * Offers one more choice after the projects: turning the thing being placed into a project of its own. With no
   * projects to list it is the only row.
   */
  readonly newProject?: ProjectChooserNewProject;
}

export interface ProjectChooserNewProject {
  /** Whether it is the current choice. A chosen row shows a check in place of its hint. */
  readonly selected: boolean;
  /** Called after the chooser closes. */
  readonly onSelect: () => void;
}

const SOURCES_META = PALETTE_SOURCES.map((source) => source.shortTitle).join(", ");

type ChooserItem =
  | { readonly kind: "no-project" }
  | { readonly kind: "project"; readonly workspace: Workspace };

const NO_PROJECT_ITEM: ChooserItem = { kind: "no-project" };
const NO_PROJECT_LABEL = "No project";
const NO_PROJECT_ROW_KEY = "no-project";

/** Starts a new-thread composer in the selected target. Add project opens the palette's Sources view. */
export function ProjectChooser({ trigger, triggerTooltip, side = "bottom", pick }: ProjectChooserProps) {
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
    pick?.onOpenChange?.(next);
  };

  const chooseItem = (item: ChooserItem) => {
    if (item.kind === "no-project") beginNoProjectThread();
    else if (pick) pick.onSelect(item.workspace);
    else beginNewThread(item.workspace.id);
    setOpenAndResetQuery(false);
  };

  const chooseNewProject = () => {
    pick?.newProject?.onSelect();
    setOpenAndResetQuery(false);
  };

  const addProject = () => {
    setOpenAndResetQuery(false);
    // Opened after the popover closes, so its focus return to the trigger cannot pull focus out of the palette.
    queueMicrotask(() => useCommandPaletteStore.getState().open({ intent: "addProject" }));
  };

  const popoverTrigger = <PopoverTrigger render={trigger} disabled={pick?.disabled} />;
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
        align={pick ? "center" : "start"}
        sideOffset={12}
        className={cn("flex flex-col gap-px p-[0.6rem]", newProjectHintShown(pick, projects) ? "w-[min(92vw,36rem)]" : "w-[min(92vw,30rem)]")}
      >
        {newProjectStandsAlone(pick, projects) ? null : (
          <ChooserList
            projects={projects}
            selectedKey={selectedChooserKey(pick, onNoProject, activeWorkspaceId)}
            query={query}
            onQueryChange={setQuery}
            onSelect={chooseItem}
            projectsOnly={pick !== undefined}
          />
        )}
        {pick ? null : (
          <>
            <div aria-hidden className="mx-0.5 mb-1 h-px shrink-0 bg-border" />
            <AddProjectRow onClick={addProject} />
          </>
        )}
        {pick?.newProject ? <NewProjectSection selected={pick.newProject.selected} hasProjects={projects.length > 0} onClick={chooseNewProject} /> : null}
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
  readonly projectsOnly: boolean;
}

function ChooserList({ projects, selectedKey, query, onQueryChange, onSelect, projectsOnly }: ChooserListProps) {
  const items = useMemo(
    () => (projectsOnly ? projectItems(projects, query) : chooserItems(projects, query)),
    [projects, query, projectsOnly],
  );
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
      noMatchLabel={projectsOnly ? (needle) => `No project matches “${needle}”.` : undefined}
    />
  );
}

function newProjectStandsAlone(pick: ProjectChooserPick | undefined, projects: readonly Workspace[]): boolean {
  return pick?.newProject !== undefined && projects.length === 0;
}

/**
 * Whether the new-project row carries its "Keeps the files" hint beside the projects. The label and the hint need
 * more width than the project names do, so the popover widens rather than fading the label.
 */
function newProjectHintShown(pick: ProjectChooserPick | undefined, projects: readonly Workspace[]): boolean {
  return pick?.newProject !== undefined && projects.length > 0;
}

/** The row to mark: the host's pick when it has one, otherwise where the new-thread composer already is. */
function selectedChooserKey(pick: ProjectChooserPick | undefined, onNoProject: boolean, activeWorkspaceId: string | null): string | undefined {
  if (pick) return pick.selectedWorkspaceId ?? undefined;
  return onNoProject ? NO_PROJECT_ROW_KEY : activeWorkspaceId ?? undefined;
}

function chooserRow(item: ChooserItem): PickerRow {
  if (item.kind === "no-project") {
    return { key: NO_PROJECT_ROW_KEY, name: NO_PROJECT_LABEL, icon: <InboxIcon aria-hidden className="size-4" />, group: "no-project" };
  }
  const { workspace } = item;
  return { key: workspace.id, name: workspace.name, icon: <ProjectIcon workspaceId={workspace.id} name={workspace.name} size={16} />, group: "projects" };
}

function projectItems(projects: readonly Workspace[], query: string): readonly ChooserItem[] {
  return filterProjects(projects, query).map((workspace): ChooserItem => ({ kind: "project", workspace }));
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

const NEW_PROJECT_LABEL = "New project from this folder";

function NewProjectSection({ selected, hasProjects, onClick }: { readonly selected: boolean; readonly hasProjects: boolean; readonly onClick: () => void }) {
  return (
    <>
      {hasProjects ? <div aria-hidden className="mx-0.5 my-1 h-px shrink-0 bg-border" /> : null}
      <NewProjectRow selected={selected} showHint={hasProjects} onClick={onClick} />
    </>
  );
}

function NewProjectRow({ selected, showHint, onClick }: { readonly selected: boolean; readonly showHint: boolean; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-hover active:bg-selected",
        FOCUS_RING_CLASS,
      )}
    >
      <PlusIcon aria-hidden className="size-[1.4rem] shrink-0 text-ink" />
      <span className="min-w-0 flex-1 text-fade text-label text-ink">{NEW_PROJECT_LABEL}</span>
      {selected ? <CheckIcon aria-hidden className="size-[1.4rem] shrink-0 text-ink" /> : showHint ? <span className="shrink-0 text-caption text-muted">Keeps the files</span> : null}
    </button>
  );
}
