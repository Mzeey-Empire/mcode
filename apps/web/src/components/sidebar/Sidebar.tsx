import { useSyncExternalStore, type ReactNode } from "react";
import { ProjectSidebar, useWorkspaceStore } from "@/features/projects";
import { FolderPlus, Search, SquarePen } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { SettingsNav } from "@/components/settings/SettingsNav";
import type { SettingsSection } from "@/components/settings/settings-nav";
import { useUiStore } from "@/stores/uiStore";
import { SidebarHeader } from "@/components/shell/SidebarHeader";
import { cn } from "@/lib/utils";
import { ReactPerformanceProfiler } from "@/performance/ReactPerformanceProfiler";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { ShortcutCombo } from "@/components/ui/shortcut-keys";
import { getKeybindingForCommand, keybindingKeycaps, subscribeKeybindings, type Keybinding } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import { SidebarFooter } from "./SidebarFooter";
import { useSidebarWidthStore } from "./sidebarWidthStore";

interface SidebarProps {
  /** Optional sizing overrides supplied by the sidebar shell. */
  className?: string;
  /** Whether the settings view is active. */
  settingsOpen?: boolean;
  /** Active settings section. */
  settingsSection?: SettingsSection;
  /** Called when the user selects a settings section. */
  onSettingsSection?: (s: SettingsSection) => void;
  /** Called when the user clicks the Settings button. */
  onOpenSettings: () => void;
  /** Called when the user clicks back from settings. */
  onCloseSettings?: () => void;
}

function getSettingsNavProps(settingsOpen: boolean | undefined, settingsSection: SettingsSection | undefined, onSettingsSection: ((section: SettingsSection) => void) | undefined): { section: SettingsSection; onSection: (section: SettingsSection) => void } | null {
  return settingsOpen && settingsSection && onSettingsSection ? { section: settingsSection, onSection: onSettingsSection } : null;
}

function useCommandBinding(commandId: string): Keybinding | undefined {
  return useSyncExternalStore(subscribeKeybindings, () => getKeybindingForCommand(commandId));
}

const ARIA_MODIFIER: Record<string, string> = { mod: isMac ? "Meta" : "Control", ctrl: "Control", shift: "Shift", alt: "Alt" };

function ariaShortcut(binding: Keybinding | undefined): string | undefined {
  if (!binding) return undefined;
  const parts = binding.key.split("+");
  const key = parts.pop() ?? "";
  return [...parts.map((part) => ARIA_MODIFIER[part.toLowerCase()] ?? part), key.length === 1 ? key.toUpperCase() : key].join("+");
}

function ActionTooltip({ name, binding }: { readonly name: string; readonly binding: Keybinding | undefined }) {
  const keys = binding ? keybindingKeycaps(binding.key, isMac) : undefined;
  return <>{name}{keys ? <span className="ml-1 flex shrink-0"><ShortcutCombo keys={keys} /></span> : null}</>;
}

const TOP_ACTION_CLASS = "size-7 text-muted hover:text-ink";

function SidebarGoZone() {
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);
  const addProjectBinding = useCommandBinding("workspace.new");
  const newThreadBinding = useCommandBinding("thread.new");
  return <div className="flex shrink-0 items-center gap-1 px-1.5">
    <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control bg-panel px-2 text-left text-body-small text-muted transition-colors duration-(--duration-fast) hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus" onClick={() => useCommandPaletteStore.getState().open({ intent: "threadSearch" })}>
      <Search size={16} aria-hidden className="shrink-0" />
      <span>Search</span>
    </button>
    <div className="flex shrink-0 gap-0.5">
      <IconButton aria-label="Add project" aria-keyshortcuts={ariaShortcut(addProjectBinding)} tooltip={<ActionTooltip name="Add project" binding={addProjectBinding} />} className={TOP_ACTION_CLASS} onClick={() => useCommandPaletteStore.getState().open({ intent: "addProject" })}>
        <FolderPlus aria-hidden />
      </IconButton>
      <IconButton data-testid="sidebar-new-thread" aria-label="New thread" aria-keyshortcuts={ariaShortcut(newThreadBinding)} tooltip={<ActionTooltip name="New thread" binding={newThreadBinding} />} className={TOP_ACTION_CLASS} onClick={() => { setPrimarySurface("chat"); useWorkspaceStore.getState().beginNewThread(); }}>
        <SquarePen aria-hidden />
      </IconButton>
    </div>
  </div>;
}

function SidebarBody({ settingsOpen, settingsSection, onSettingsSection }: { settingsOpen: boolean | undefined; settingsSection: SettingsSection | undefined; onSettingsSection: ((section: SettingsSection) => void) | undefined }) {
  const settingsNavProps = getSettingsNavProps(settingsOpen, settingsSection, onSettingsSection);
  if (settingsNavProps) {
    return <div data-testid="sidebar-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain"><SettingsNav {...settingsNavProps} /></div>;
  }
  return <>
    <SidebarGoZone />
    <div data-testid="sidebar-body" className="flex min-h-0 flex-1 flex-col overflow-hidden px-1.5"><ReactPerformanceProfiler id="sidebar"><ProjectSidebar /></ReactPerformanceProfiler></div>
  </>;
}

// Only this frame reads the width, so a seam drag re-renders one div rather than the project tree.
function SidebarFrame({ settingsOpen, className, children }: { settingsOpen: boolean | undefined; className: string | undefined; children: ReactNode }) {
  const width = useSidebarWidthStore((s) => s.width);
  return <div data-testid="sidebar" style={{ width }} className={cn("flex h-full flex-col gap-4 bg-page pb-3", settingsOpen ? "max-w-[42vw] border-r border-border md:max-w-none" : "max-w-[55vw] md:max-w-none", className)}>
    {children}
  </div>;
}

/** Sidebar component that renders app navigation, project tree, or settings nav. */
export function Sidebar({
  className,
  settingsOpen,
  settingsSection,
  onSettingsSection,
  onOpenSettings,
  onCloseSettings,
}: SidebarProps) {
  return (
    <SidebarFrame settingsOpen={settingsOpen} className={className}>
      <SidebarHeader />
      <SidebarBody settingsOpen={settingsOpen} settingsSection={settingsSection} onSettingsSection={onSettingsSection} />
      <SidebarFooter settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} onCloseSettings={onCloseSettings} />
    </SidebarFrame>
  );
}
