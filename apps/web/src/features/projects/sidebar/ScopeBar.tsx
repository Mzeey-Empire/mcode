import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { useWorkspaceStore } from "../state/workspaceStore";
import { effectiveSidebarScope, useSidebarUiStore, type SidebarScope } from "./sidebar-ui-store";

function countCompleted(threads: readonly { readonly user_completed_at: string | null }[]): number {
  let count = 0;
  for (const thread of threads) if (thread.user_completed_at !== null) count += 1;
  return count;
}

/** Number of server-confirmed completed threads across every project. */
export function useCompletedThreadCount(): number {
  return useWorkspaceStore((state) => countCompleted(state.threads));
}

/** The scope the sidebar lists, already falling back to Active when nothing is completed. */
export function useSidebarScope(): SidebarScope {
  const scope = useSidebarUiStore((state) => state.scope);
  return effectiveSidebarScope(scope, useCompletedThreadCount());
}

function isSidebarScope(value: string): value is SidebarScope {
  return value === "active" || value === "completed";
}

interface ScopeBarProps {
  /** True once any thread is completed, even while the first one is still flying in. */
  readonly visible: boolean;
  /** The count to show, which may trail the model while a completed row is still on its way. */
  readonly completedCount: number;
  readonly scope: SidebarScope;
}

/**
 * Shows Active / Completed while completed threads exist; resets to Active when none remain. It
 * expands when the first thread completes and collapses when the last one goes, so the list
 * below slides instead of jumping. Hydration shows or hides it at once.
 */
export function ScopeBar({ visible, completedCount, scope }: ScopeBarProps) {
  const setScope = useSidebarUiStore((state) => state.setScope);
  const { animate, entering, collapsing, collapsed } = useBarEntrance(visible);
  const lastCount = useRef(completedCount);
  if (visible) lastCount.current = completedCount;

  useEffect(() => {
    if (!visible && useSidebarUiStore.getState().scope !== "active") setScope("active");
  }, [visible, setScope]);

  if (!visible && !collapsing) return null;
  const options: readonly SegmentedOption[] = [
    { value: "active", label: "Active" },
    { value: "completed", label: "Completed", count: lastCount.current },
  ];
  return (
    <AnimatedCollapsible
      open={visible}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !visible) collapsed();
      }}
      className={cn(
        "mx-1.5 shrink-0 transition-[grid-template-rows,opacity] duration-[220ms] ease-[cubic-bezier(.2,.7,.2,1)]",
        !animate && "transition-none",
        visible ? "opacity-100" : "opacity-0",
        entering && "starting:grid-rows-[0fr] starting:opacity-0",
      )}
    >
      <div data-testid={visible ? "sidebar-scope-bar" : undefined}>
        <SegmentedControl
          aria-label="Thread scope"
          size="compact"
          fill
          options={options}
          value={scope}
          onChange={(value) => {
            if (isSidebarScope(value)) setScope(value);
          }}
        />
      </div>
    </AnimatedCollapsible>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function barTransition(seen: { visible: boolean; epoch: number }, visible: boolean, epoch: number) {
  const animate = seen.epoch === epoch && !prefersReducedMotion();
  return { animate, entering: animate && !seen.visible && visible, hiding: animate && seen.visible && !visible };
}

/**
 * Animates only visibility changes made by pushes, never under reduced motion: a new snapshot
 * epoch (startup, reconnect) shows or hides the bar at once. A collapsing bar stays mounted until
 * its transition ends.
 */
function useBarEntrance(visible: boolean) {
  const epoch = useWorkspaceStore((state) => state.threadSnapshotEpoch);
  const seen = useRef({ visible, epoch });
  const [collapsing, setCollapsing] = useState(false);
  const { animate, entering, hiding } = barTransition(seen.current, visible, epoch);
  const nextCollapsing = hiding || (collapsing && !visible);
  if (nextCollapsing !== collapsing) setCollapsing(nextCollapsing);

  useEffect(() => {
    seen.current = { visible, epoch };
  }, [visible, epoch]);

  return { animate, entering, collapsing: nextCollapsing, collapsed: () => setCollapsing(false) };
}
