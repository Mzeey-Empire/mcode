import { useEffect, useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useProjectSelectorStore } from "@/stores/projectSelectorStore";
import { useRecentThreadsStore } from "@/stores/recentThreadsStore";
import { Button } from "@/components/ui/button";
import { ProjectRow } from "./ProjectRow";
import { RecentThreadRow } from "./RecentThreadRow";
import { Kbd } from "../palette/Kbd";
import type { RecentThread } from "@/transport/types";

/**
 * Full-screen cold-start landing shown when no workspace is active.
 * Renders the app wordmark, then pinned and recent projects.
 * Opening a project calls setActiveWorkspace (same as the palette flow).
 * The "+ Add project" button opens the palette in browse mode (input seeded to `~/`).
 */
export function ProjectSelectorLanding() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveThread = useWorkspaceStore((s) => s.setActiveThread);
  const setPendingNewThread = useWorkspaceStore((s) => s.setPendingNewThread);
  const pinWorkspace = useWorkspaceStore((s) => s.pinWorkspace);
  const removeRecent = useWorkspaceStore((s) => s.removeRecent);
  const openPalette = useCommandPaletteStore((s) => s.open);

  const pinned = useMemo(() => workspaces.filter((w) => w.pinned), [workspaces]);
  const recent = useMemo(
    () => workspaces.filter((w) => !w.pinned && w.last_opened_at != null),
    [workspaces],
  );
  const hasProjects = pinned.length > 0 || recent.length > 0;

  // Cross-workspace recent threads — fetched once on mount. The store dedupes
  // concurrent calls so a remount during slow networks doesn't burst the RPC.
  const recentThreads = useRecentThreadsStore((s) => s.threads);
  const fetchRecentThreads = useRecentThreadsStore((s) => s.fetch);
  useEffect(() => {
    fetchRecentThreads();
  }, [fetchRecentThreads]);

  // Cap the visible thread count — the cold-start landing isn't a full thread
  // browser. Five is enough to recognise "yes, this is where I left off" without
  // pushing the wordmark or recent-projects section offscreen on short viewports.
  // The palette remains the entry point for the longer history.
  const visibleRecentThreads = useMemo(() => recentThreads.slice(0, 5), [recentThreads]);
  const hasRecentThreads = visibleRecentThreads.length > 0;
  const hasContent = hasProjects || hasRecentThreads;

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

  // Picking a project from the landing means "I want to start work on this".
  // Drop straight into the new-thread composer for that workspace — without
  // setPendingNewThread the landing's `showLanding` guard
  // (activeThreadId === null && !pendingNewThread) stays true and the user
  // visibly goes nowhere.
  const handleSelect = (id: string) => {
    setActiveWorkspace(id);
    setPendingNewThread(true);
  };
  const handlePin = (id: string, pinned: boolean) => void pinWorkspace(id, pinned);
  const handleRemove = (id: string) => void removeRecent(id);
  const handleAdd = () => openPalette({ intent: "addProject" });
  /**
   * Open a thread from the recent-threads list. Activate the parent workspace
   * first so downstream selectors (sidebar highlight, breadcrumb, settings) see
   * the right workspace before the thread itself becomes active — same ordering
   * as the palette's thread-open flow in `RootView.handleSelect`.
   */
  const handleSelectThread = (thread: RecentThread) => {
    setActiveWorkspace(thread.workspace_id);
    setActiveThread(thread.id);
  };

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    // `flex-1 min-h-0` (instead of `h-full`) so when this is nested in a flex
    // column with a sibling — e.g. the sidebar-reveal strip rendered by App.tsx
    // when the sidebar is collapsed — we claim only our allotted slot rather
    // than overflowing the parent and pushing the absolute keyboard hint
    // (`bottom-6`) below the viewport.
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Scrollable column — `my-auto` on the inner stack centers content when it
          fits and falls back to natural top-alignment when it overflows, so the
          wordmark never gets pushed offscreen on short viewports.
          `pb-16` keeps the bottom keyboard hint from overlapping list items. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pb-16">
        <div className="my-auto flex w-full flex-col items-center py-8">
          {/* Wordmark — generous size + a small caret accent give the cold-start a moment of personality */}
          <div className="mb-12 flex items-baseline gap-1 select-none font-mono text-[34px] font-semibold leading-none tracking-tight text-foreground">
            <span>mcode</span>
            <span aria-hidden className="text-primary/80">_</span>
          </div>

          {hasContent ? (
        <div className="w-full max-w-lg">
          {hasRecentThreads && (
            <section className="mb-5">
              <h2 className="mb-2 px-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/70">
                Recent threads
              </h2>
              {visibleRecentThreads.map((t) => (
                <RecentThreadRow
                  key={t.id}
                  thread={t}
                  onSelect={handleSelectThread}
                />
              ))}
            </section>
          )}

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

          <Button
            data-testid="landing-add-project"
            variant="outline"
            onClick={handleAdd}
            className="group mt-2 w-full gap-2 py-2.5 text-[12.5px] text-foreground/80"
          >
            <span aria-hidden className="text-base leading-none text-muted-foreground/60 group-hover:text-foreground">+</span>
            Add project
          </Button>
        </div>
      ) : (
        /* Empty state — gives the brand-new user a single confident next step */
        <div className="flex flex-col items-center gap-5">
          <p className="text-[13px] text-muted-foreground/70">
            No projects yet — open a folder to get started.
          </p>
          <Button
            data-testid="landing-add-project"
            onClick={handleAdd}
            className="gap-2 px-4 py-2 text-[13px]"
          >
            <span aria-hidden className="text-base leading-none">+</span>
            Open a folder
          </Button>
        </div>
      )}
        </div>
      </div>

      {/* Keyboard hint — surfaces the palette so power users know it exists.
          Pinned to the bottom so it doesn't compete with the wordmark/list.
          Sits outside the scroll container so it stays anchored as the list scrolls. */}
      <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1.5 font-mono text-[10.5px] tracking-[0.06em] text-muted-foreground/55">
        <Kbd>{modKey}</Kbd>
        <Kbd>P</Kbd>
        <span className="ml-1">Command palette</span>
      </div>
    </div>
  );
}
