import { useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { ProjectRow } from "./ProjectRow";

/**
 * Full-screen cold-start landing shown when no workspace is active.
 * Renders the app wordmark, then pinned and recent projects.
 * Opening a project calls setActiveWorkspace (same as the palette flow).
 * The "+ Add project" button opens the addProject palette view.
 */
export function ProjectSelectorLanding() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const pinWorkspace = useWorkspaceStore((s) => s.pinWorkspace);
  const removeRecent = useWorkspaceStore((s) => s.removeRecent);
  const openPalette = useCommandPaletteStore((s) => s.open);

  const pinned = useMemo(() => workspaces.filter((w) => w.pinned), [workspaces]);
  const recent = useMemo(
    () => workspaces.filter((w) => !w.pinned && w.last_opened_at != null),
    [workspaces],
  );
  const hasProjects = pinned.length > 0 || recent.length > 0;

  const handleSelect = (id: string) => setActiveWorkspace(id);
  const handlePin = (id: string, pinned: boolean) => void pinWorkspace(id, pinned);
  const handleRemove = (id: string) => void removeRecent(id);
  const handleAdd = () => openPalette({ intent: "addProject" });

  return (
    <div className="flex h-full flex-col items-center justify-center">
      {/* Wordmark */}
      <div className="mb-10 select-none font-mono text-2xl font-semibold tracking-tight text-foreground/80">
        mcode
      </div>

      {hasProjects ? (
        <div className="w-full max-w-lg">
          {pinned.length > 0 && (
            <section className="mb-4">
              <h2 className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/40">
                Pinned
              </h2>
              {pinned.map((w) => (
                <ProjectRow
                  key={w.id}
                  workspace={w}
                  onSelect={handleSelect}
                  onPin={handlePin}
                />
              ))}
            </section>
          )}

          {recent.length > 0 && (
            <section className="mb-6">
              <h2 className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/40">
                Recent
              </h2>
              {recent.map((w) => (
                <ProjectRow
                  key={w.id}
                  workspace={w}
                  onSelect={handleSelect}
                  onPin={handlePin}
                  onRemove={handleRemove}
                />
              ))}
            </section>
          )}

          <button
            data-testid="landing-add-project"
            onClick={handleAdd}
            className="mt-2 w-full rounded-md border border-dashed border-border/60 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.14em] text-muted-foreground/50 transition-colors hover:border-border hover:text-muted-foreground"
          >
            + Add project
          </button>
        </div>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center gap-4">
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-muted-foreground/40">
            No projects yet
          </p>
          <button
            data-testid="landing-add-project"
            onClick={handleAdd}
            className="rounded-md bg-primary/90 px-4 py-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-primary-foreground hover:bg-primary"
          >
            + Add project
          </button>
        </div>
      )}
    </div>
  );
}
