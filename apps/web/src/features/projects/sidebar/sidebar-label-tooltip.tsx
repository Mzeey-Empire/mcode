import { createContext, useContext, type ReactElement } from "react";
import { Pencil } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, type TooltipHandle } from "@/components/ui/tooltip";
import { useSidebarWidthStore } from "@/components/sidebar/sidebarWidthStore";
import type { ThreadStatusLook } from "@/features/thread-attention/thread-row-presentation";
import { StatusMark } from "@/components/ui/status-mark";
import { cn } from "@/lib/utils";

/** Sidebar width below which grouped rows show their status icon alone. */
export const SIDEBAR_NARROW_WIDTH = 260;

/** True while the sidebar is narrower than {@link SIDEBAR_NARROW_WIDTH}. */
export function useSidebarNarrow(): boolean {
  return useSidebarWidthStore((state) => state.width < SIDEBAR_NARROW_WIDTH);
}

/**
 * Sidebar width below which a By project row shows its status icon alone. Measured, not chosen:
 * at 438px the longest meta line ("Approval required" beside a "2163 +2" chip) first keeps 20
 * branch characters; below it the status word squeezes the branch to a stub.
 */
export const SIDEBAR_STATUS_WORD_WIDTH = 440;

/**
 * True while the sidebar is narrower than {@link SIDEBAR_STATUS_WORD_WIDTH}. A boolean selector,
 * so rows re-render only when the tier flips, not on every resize step.
 */
export function useSidebarStatusIconOnly(): boolean {
  return useSidebarWidthStore((state) => state.width < SIDEBAR_STATUS_WORD_WIDTH);
}

/** The list's shared label tooltip. Null outside a list, where icons render without one. */
export const SidebarLabelHandleContext = createContext<TooltipHandle<string> | null>(null);

/** The one label tooltip the sidebar list renders; icon-only labels bind triggers to `handle`. */
export function SidebarLabelTooltip({ handle }: { handle: TooltipHandle<string> }) {
  return (
    <Tooltip handle={handle}>
      {({ payload }) => (payload ? <TooltipContent side="right">{payload}</TooltipContent> : null)}
    </Tooltip>
  );
}

/** Names an icon-only status in the shared tooltip, so a row never mounts a tooltip root of its own. */
export function SidebarLabelTrigger({ label, children }: { label: string; children: ReactElement }) {
  const handle = useContext(SidebarLabelHandleContext);
  if (!handle) return children;
  return <TooltipTrigger handle={handle} payload={label} render={children} />;
}

/**
 * Leads a title that has an unsent draft. `iconOnly` keeps "Draft" as visually hidden text, so the
 * pencil still has a name, and names it in the shared tooltip.
 */
export function DraftTag({ iconOnly = false }: { iconOnly?: boolean }) {
  const tag = (
    <span data-testid="draft-tag" className="flex shrink-0 items-center gap-1 text-caption font-medium text-draft">
      <Pencil size={14} aria-hidden />
      <span className={cn(iconOnly && "sr-only")}>Draft</span>
    </span>
  );
  return iconOnly ? <SidebarLabelTrigger label="Draft">{tag}</SidebarLabelTrigger> : tag;
}

/** A status shown as its icon alone: the icon keeps its accessible name, and the shared tooltip shows the label and any detail. */
export function IconOnlyStatus({ look }: { look: ThreadStatusLook }) {
  return (
    <SidebarLabelTrigger label={look.detail ? `${look.label} · ${look.detail}` : look.label}>
      <span className="inline-flex"><StatusMark state={look.state} label={look.label} icon={look.icon} /></span>
    </SidebarLabelTrigger>
  );
}
