import type { LucideIcon } from "lucide-react";
import { Globe, Terminal, Files, Diff, FileText, Layers, Settings } from "lucide-react";
import type { RightPanelTool } from "@/stores/diffStore";

/**
 * Whether a thread is active. Tab availability is filtered by scope first: some
 * tab types (Plan) only make sense once a thread exists, so they are
 * dropped when the panel runs threadless against the workspace root. See ADR-0004.
 */
export type PanelScope = "threadless" | "thread";

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
  /** Command id whose keybinding renders as the card's keycap, when it has one. */
  readonly commandId?: string;
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
    blurb: "Open a website",
    needsThread: false,
    commandId: "preview.toggle",
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    blurb: "Start a shell",
    needsThread: false,
    commandId: "terminal.toggle",
  },
  {
    id: "files",
    label: "Files",
    icon: Files,
    blurb: "Browse project files",
    needsThread: false,
    commandId: "files.toggle",
  },
  {
    id: "changes",
    label: "Review",
    icon: Diff,
    blurb: "View code changes",
    // Dual-scope: the git working-tree views (Unstaged/Staged/Commit/Branch)
    // read the workspace root and need no thread; a thread adds the turn views.
    // See CONTEXT.md → "Review tab".
    needsThread: false,
    commandId: "changes.toggle",
  },
  {
    id: "environment",
    label: "Project settings",
    icon: Settings,
    blurb: "Edit Project environment",
    needsThread: false,
    commandId: "projectEnvironment.open",
  },
  {
    id: "tasks",
    label: "Plan",
    icon: FileText,
    blurb: "Review the plan",
    needsThread: true,
    commandId: "tasks.toggle",
  },
  {
    id: "subagents",
    label: "Subagents",
    icon: Layers,
    blurb: "Follow delegated work",
    needsThread: true,
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
    const allowedInScope = scope === "thread" || !type.needsThread;
    return allowedInScope && !openTabs.includes(type.id);
  });
}
