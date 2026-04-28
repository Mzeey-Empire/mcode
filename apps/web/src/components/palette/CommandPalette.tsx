import { useEffect } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Command, CommandInput } from "@/components/ui/command";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { setContext } from "@/lib/context-tracker";
import { RootView } from "./views/RootView";
import { ProjectsView } from "./views/ProjectsView";
import { AddProjectView } from "./views/AddProjectView";
import { SelectionListView } from "./views/SelectionListView";

/**
 * Top-center floating command palette overlay.
 * Navigation is stack-based via commandPaletteStore.viewStack — subviews
 * push onto the stack without spawning sub-modals. Backspace on an empty
 * input pops the stack (or closes if on the root view).
 */
export function CommandPalette() {
  const { isOpen, viewStack, query, setQuery, close, pop, pendingConfirm } = useCommandPaletteStore();
  const top = viewStack[viewStack.length - 1];

  // Keep context tracker in sync so keybinding `when` clauses can check palette state
  useEffect(() => {
    setContext("commandPaletteOpen", isOpen);
  }, [isOpen]);

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(o) => !o && close()} modal="trap-focus">
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm" />
        <DialogPrimitive.Popup className="fixed left-1/2 top-[clamp(4rem,15vh,9rem)] z-50 w-full max-w-xl -translate-x-1/2 outline-none">
          <Command
            className="rounded-lg border border-border bg-popover shadow-2xl"
            shouldFilter={false}
            loop
          >
            <CommandInput
              autoFocus
              placeholder="Search commands, projects, threads…"
              value={query}
              onValueChange={setQuery}
              onKeyDown={(e) => {
                // Ctrl/Cmd+Enter triggers the active view's confirm action
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && pendingConfirm) {
                  e.preventDefault();
                  pendingConfirm();
                  return;
                }
                // Backspace on empty input pops the view stack
                if (e.key === "Backspace" && query === "" && viewStack.length > 1) {
                  e.preventDefault();
                  pop();
                }
              }}
              className="text-[13.5px]"
            />
            {top?.kind === "root" && <RootView />}
            {top?.kind === "projects" && <ProjectsView />}
            {top?.kind === "addProject" && <AddProjectView path={top.path} />}
            {top?.kind === "selectionList" && <SelectionListView view={top} />}
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
