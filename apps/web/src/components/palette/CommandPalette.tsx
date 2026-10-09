import { useEffect, type KeyboardEventHandler } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Command as CommandPrimitive } from "cmdk";
import { Plus, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { setContext } from "@/lib/context-tracker";
import { RootView } from "./views/RootView";
import { ProjectsView } from "@/features/projects";
import { BrowseView } from "./views/BrowseView";
import { SelectionListView } from "./views/SelectionListView";
import { SourcesView } from "./views/SourcesView";
import { ThreadSearchView } from "./views/ThreadSearchView";
import { isBrowseQuery, getPaletteMode } from "./CommandPalette.logic";
import { cn } from "@/lib/utils";
import { DIALOG_FADE_CLASS } from "@/components/ui/overlay-surface";

type PaletteView = ReturnType<typeof useCommandPaletteStore.getState>["viewStack"][number];

function isPaletteFocused(): boolean {
  return document.querySelector<HTMLElement>('[data-testid="command-palette"]')?.contains(document.activeElement) ?? false;
}

function consumePendingConfirm(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return false;
  const confirm = useCommandPaletteStore.getState().pendingConfirm;
  if (!confirm) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  confirm();
  return true;
}

function consumePendingBack(event: KeyboardEvent): void {
  if (event.key !== "ArrowUp" || !event.altKey) return;
  const back = useCommandPaletteStore.getState().pendingBack;
  if (!back) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  back();
}

/**
 * Paper's 02a list styling, applied from the palette root so every view's groups and rows match
 * without changing the shared `Command` primitives other pickers use. The extra attribute in each
 * selector outranks the primitives' own `[cmdk-group-heading]` and `aria-selected` utilities.
 */
const PALETTE_LIST_CLASS = cn(
  "[&_[cmdk-group][data-slot]]:p-0",
  "[&_[cmdk-group]_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group]_[cmdk-group-heading]]:pt-0.5 [&_[cmdk-group]_[cmdk-group-heading]]:pb-1 [&_[cmdk-group]_[cmdk-group-heading]]:font-normal",
  "[&_[cmdk-item][data-slot]]:rounded-badge [&_[cmdk-item][aria-selected=true]]:bg-hover",
);

function getPaletteDetails(browseMode: boolean, top: PaletteView | undefined, query: string): { placeholder: string; inputLabel: string; modeLabel: string } {
  if (browseMode) return { placeholder: "Type a path or filter…", inputLabel: "Folder path or folder filter", modeLabel: "browse" };
  if (top?.kind === "sources") return { placeholder: "Search sources, or type ~/ to browse", inputLabel: "Search sources", modeLabel: "sources" };
  if (top?.kind === "projects") return { placeholder: "Search projects…", inputLabel: "Command palette search", modeLabel: "projects" };
  if (top?.kind === "threadSearch") return { placeholder: "Search threads, projects, branches, worktrees…", inputLabel: "Search threads", modeLabel: "threads" };
  if (top?.kind === "selectionList") return { placeholder: `Search ${top.title.toLowerCase()}…`, inputLabel: "Command palette search", modeLabel: getPaletteMode(query) };
  return { placeholder: "Search commands, type ~/ to browse, > for actions only…", inputLabel: "Command palette search", modeLabel: getPaletteMode(query) };
}

function PaletteViewContent({ browseMode, top }: { browseMode: boolean; top: PaletteView | undefined }) {
  if (browseMode) return <BrowseView />;
  if (top?.kind === "sources") return <SourcesView />;
  if (top?.kind === "projects") return <ProjectsView />;
  if (top?.kind === "threadSearch") return <ThreadSearchView />;
  if (top?.kind === "selectionList") return <SelectionListView view={top} />;
  return <RootView />;
}

/**
 * Top-center floating command palette overlay — the single shell that handles
 * commands, project picking, thread switching, and folder browsing.
 *
 * A path query (`~/`, a drive) renders `<BrowseView />` from any view, so folder
 * browsing needs no view of its own. Otherwise the top of the view stack picks
 * the view, and the root view's mode comes from the query (see `getPaletteMode`).
 */
export function CommandPalette() {
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const viewStack = useCommandPaletteStore((s) => s.viewStack);
  const query = useCommandPaletteStore((s) => s.query);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);
  const close = useCommandPaletteStore((s) => s.close);
  const pop = useCommandPaletteStore((s) => s.pop);
  const pendingConfirm = useCommandPaletteStore((s) => s.pendingConfirm);

  const top = viewStack[viewStack.length - 1];
  const browseMode = isBrowseQuery(query);

  // Keep context tracker in sync so keybinding `when` clauses can check palette state
  useEffect(() => {
    setContext("commandPaletteOpen", isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleBrowseShortcut = (event: KeyboardEvent) => {
      if (!isPaletteFocused()) return;
      if (consumePendingConfirm(event)) return;
      if (browseMode) consumePendingBack(event);
    };

    window.addEventListener("keydown", handleBrowseShortcut, true);
    return () => window.removeEventListener("keydown", handleBrowseShortcut, true);
  }, [browseMode, isOpen]);

  const paletteDetails = getPaletteDetails(browseMode, top, query);

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(o) => !o && close()} modal="trap-focus">
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop data-slot="palette-backdrop" className={cn("fixed inset-0 z-(--layer-modal) bg-page/60", DIALOG_FADE_CLASS)} />
        <DialogPrimitive.Popup
          data-testid="command-palette"
          aria-label="Command palette"
          className={cn("fixed left-1/2 top-20 z-(--layer-modal) w-[60rem] max-w-[calc(100vw-3.2rem)] -translate-x-1/2 outline-none", DIALOG_FADE_CLASS)}
        >
          <Command
            className={cn(
              "gap-px overflow-hidden rounded-[1.2rem] border border-border bg-panel p-1.5 text-ink shadow-popover",
              PALETTE_LIST_CLASS,
            )}
            // We do all filtering/ranking ourselves (filterCommandPaletteGroups,
            // BrowseView's leaf prefix filter, ProjectsView's substring filter),
            // so disable cmdk's built-in filter. Letting it run against the raw
            // query incorrectly hides matches when the query has special prefixes
            // like `>` or `~/` that don't appear in any item's value.
            shouldFilter={false}
            loop
          >
            <PaletteInput
              placeholder={paletteDetails.placeholder}
              query={query}
              setQuery={setQuery}
              browseMode={browseMode}
              canAdd={pendingConfirm != null}
              inputLabel={paletteDetails.inputLabel}
              modeLabel={paletteDetails.modeLabel}
              onKeyDown={(e) => {
                // Backspace on empty input pops the view stack.
                if (e.key === "Backspace" && query === "" && viewStack.length > 1) {
                  e.preventDefault();
                  pop();
                }
              }}
              onAddClick={() => pendingConfirm?.()}
            />

            <PaletteViewContent browseMode={browseMode} top={top} />
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Input row with the search icon on the left and the browse confirmation
 * action on the right when a folder path is active.
 */
function PaletteInput({
  placeholder,
  query,
  setQuery,
  browseMode,
  canAdd,
  inputLabel,
  modeLabel,
  onKeyDown,
  onAddClick,
}: {
  placeholder: string;
  query: string;
  setQuery: (q: string) => void;
  browseMode: boolean;
  canAdd: boolean;
  inputLabel: string;
  modeLabel: string;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onAddClick: () => void;
}) {
  return (
    <>
      <div
        data-slot="palette-input-wrapper"
        data-palette-mode={modeLabel}
        className="flex h-[3.4rem] shrink-0 items-center gap-2 px-2.5"
      >
        <SearchIcon aria-hidden className="size-[1.4rem] shrink-0 text-muted" strokeWidth={1.5} />
        <CommandPrimitive.Input
          autoFocus
          data-slot="palette-input"
          placeholder={placeholder}
          value={query}
          aria-label={inputLabel}
          onValueChange={setQuery}
          onKeyDownCapture={onKeyDown}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-body-small text-ink outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-50",
            browseMode && "font-mono",
          )}
        />
        {browseMode && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex shrink-0">
                  <Button
                    type="button"
                    variant="default"
                    size="compact"
                    data-testid="palette-add-folder"
                    disabled={!canAdd}
                    onMouseDown={(e) => {
                      // Prevent the input from losing focus, which would dismiss cmdk highlight.
                      e.preventDefault();
                    }}
                    onClick={onAddClick}
                    className="h-[2.6rem] gap-1.5 px-2.5 text-caption"
                  >
                    <Plus size={14} />
                    Add project
                  </Button>
                </span>
              }
            />
            <TooltipContent>
              {canAdd ? "Add this folder as a project" : "Choose a folder before adding a project"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div aria-hidden data-slot="palette-divider" className="mx-0.5 mt-0.5 mb-1 h-px shrink-0 bg-border" />
    </>
  );
}
