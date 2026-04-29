import { useEffect, useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useProjectSelectorStore } from "@/stores/projectSelectorStore";
import { ProjectRow } from "./ProjectRow";
import { Kbd } from "../palette/Kbd";

/**
 * Full-screen cold-start landing shown when no workspace is active.
 * Renders the app wordmark, then pinned and recent projects.
 * Opening a project calls setActiveWorkspace (same as the palette flow).
 * The "+ Add project" button opens the palette in browse mode (input seeded to `~/`).
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

  // Batch the enrichment fetch for every visible row in a single RPC. Without
  // this, each ProjectRow would fire its own enrich([id]) on mount — N rows = N
  // sequential round-trips, which is visibly slow on the cold-start landing.
  const enrich = useProjectSelectorStore((s) => s.enrich);
  const visibleIds = useMemo(
    () => [...pinned, ...recent].map((w) => w.id),
    [pinned, recent],
  );
  useEffect(() => {
    if (visibleIds.length > 0) enrich(visibleIds);
  }, [visibleIds, enrich]);

  const handleSelect = (id: string) => setActiveWorkspace(id);
  const handlePin = (id: string, pinned: boolean) => void pinWorkspace(id, pinned);
  const handleRemove = (id: string) => void removeRecent(id);
  const handleAdd = () => openPalette({ intent: "addProject" });

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    <div className="relative flex h-full flex-col items-center justify-center">
      {/* Wordmark — generous size + a small caret accent give the cold-start a moment of personality */}
      <div className="mb-12 flex items-baseline gap-1 select-none font-mono text-[34px] font-semibold leading-none tracking-tight text-foreground">
        <span>mcode</span>
        <span aria-hidden className="text-primary/80">_</span>
      </div>

      {hasProjects ? (
        <div className="w-full max-w-lg">
          {pinned.length > 0 && (
            <section className="mb-5">
              <h2 className="mb-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
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
              <h2 className="mb-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
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
            className="group mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md border border-border/70 bg-secondary/40 py-2.5 text-[12.5px] text-foreground/80 transition-colors hover:border-border hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span aria-hidden className="text-base leading-none text-muted-foreground/60 group-hover:text-foreground">+</span>
            Add project
          </button>
        </div>
      ) : (
        /* Empty state — gives the brand-new user a single confident next step */
        <div className="flex flex-col items-center gap-5">
          <p className="text-[13px] text-muted-foreground/70">
            No projects yet — open a folder to get started.
          </p>
          <button
            data-testid="landing-add-project"
            onClick={handleAdd}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span aria-hidden className="text-base leading-none">+</span>
            Open a folder
          </button>
        </div>
      )}

      {/* Keyboard hint — surfaces the palette so power users know it exists.
          Pinned to the bottom so it doesn't compete with the wordmark/list. */}
      <div className="pointer-events-none absolute bottom-6 flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.06em] text-muted-foreground/55">
        <Kbd>{modKey}</Kbd>
        <Kbd>P</Kbd>
        <span className="ml-1">Command palette</span>
      </div>
    </div>
  );
}
