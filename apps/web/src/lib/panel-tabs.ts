import type { LucideIcon } from "lucide-react";
import { Globe, Terminal, Files, Diff, FileText, Layers, Settings } from "lucide-react";
import type { RightPanelTool } from "@/stores/diffStore";

/**
 * Whether a thread is active, and whether it has a project. Tab availability is filtered by scope first: some
 * tab types (Plan) only make sense once a thread exists, so they are
 * dropped when the panel runs threadless against the workspace root. A No project thread has no repository and
 * no project to configure, so it also drops the project-only types. See ADR-0004.
 */
export type PanelScope = "threadless" | "thread" | "no-project-thread";

/** Returns no-project-thread for a No project workspace, even when threadId is null. */
export function resolvePanelScope(threadId: string | null, inNoProjectWorkspace: boolean): PanelScope {
  if (inNoProjectWorkspace) return "no-project-thread";
  return threadId ? "thread" : "threadless";
}

/**
 * Static metadata describing one panel tab type for the availability model and
 * the empty-state card grid. Pure data — no store or React state.
 */
export interface PanelTabType {
  /** Stable id, one per {@link RightPanelTool}. */
  readonly id: RightPanelTool;
  /** Product-facing name shown on the card (e.g. "Browser", "Review"). */
  readonly label: string;
  /** Card glyph. */
  readonly icon: LucideIcon;
  /** One-line description shown under the label on the empty-state card. */
  readonly blurb: string;
  /** Only creatable once a thread exists; dropped by the scope filter when threadless. */
  readonly needsThread: boolean;
  /** Reads a git repository or a project's shared settings; dropped for a No project thread, which has neither. */
  readonly projectOnly?: boolean;
  /** Command id whose keybinding renders as the card's keycap, when it has one. */
  readonly commandId?: string;
  /**
   * The rail exit only hides this tool and leaves its work running. It gets this name and a minus glyph, so it never
   * looks like the × on an item tab that ends the item.
   */
  readonly hideLabel?: string;
}

/**
 * The revamp's tab-type catalog, in display order (ADR-0004). Order is the
 * single source of truth for how cards and rail entries are laid out, so the
 * availability helpers preserve it. Labels are the product language (Browser,
 * Review, Plan) even though the openable ids reuse the legacy
 * {@link RightPanelTool} values (preview, changes, tasks).
 */
export const PANEL_TAB_TYPES: readonly PanelTabType[] = [
  {
    id: "preview",
    label: "Browser",
    icon: Globe,
    blurb: "Web pages for this thread",
    needsThread: false,
    commandId: "preview.toggle",
    // Pages live in the preview tabs store, not the panel, so hiding Browser leaves them open.
    hideLabel: "Hide Browser (pages stay open)",
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    blurb: "Shells in this thread's checkout",
    needsThread: false,
    commandId: "terminal.toggle",
    // Closing the rail entry only hides the tool; terminal records are not ended.
    hideLabel: "Hide Terminal (shells keep running)",
  },
  {
    id: "files",
    label: "Files",
    icon: Files,
    blurb: "Files in this thread's checkout",
    needsThread: false,
    commandId: "files.toggle",
  },
  {
    id: "changes",
    label: "Review",
    icon: Diff,
    blurb: "Diffs in this thread's checkout",
    // Dual-scope: the git working-tree views (Unstaged/Staged/Commit/Branch)
    // read the workspace root and need no thread; a thread adds the turn views.
    // See CONTEXT.md → "Review tab".
    needsThread: false,
    projectOnly: true,
    commandId: "changes.toggle",
  },
  {
    id: "environment",
    label: "Project settings",
    icon: Settings,
    blurb: "Shared by all project threads",
    needsThread: false,
    projectOnly: true,
    commandId: "projectEnvironment.open",
  },
  {
    id: "tasks",
    label: "Plan",
    icon: FileText,
    blurb: "The agent's plan for this thread",
    needsThread: true,
    commandId: "tasks.toggle",
  },
  {
    id: "subagents",
    label: "Subagents",
    icon: Layers,
    blurb: "Agents this thread delegated to",
    needsThread: true,
    commandId: "subagents.toggle",
  },
];

/**
 * Tools displayed in the current scope, in catalog order: scope-filtered
 * (thread-only types dropped when threadless) then cardinality-filtered (open
 * tools dropped, since the rail lists each tool once and Terminal and Browser
 * add items from their own row-1 tab strip; ADR-0026). Every shown type is
 * creatable. Pure.
 */
export function shownTabTypes(
  scope: PanelScope,
  openTabs: readonly RightPanelTool[],
): readonly PanelTabType[] {
  return PANEL_TAB_TYPES.filter((type) => {
    const allowedInScope = scope !== "threadless" || !type.needsThread;
    const allowedForProject = scope !== "no-project-thread" || !type.projectOnly;
    return allowedInScope && allowedForProject && !openTabs.includes(type.id);
  });
}
