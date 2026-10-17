import type { ReactNode } from "react";
import { ProjectTree, useWorkspaceStore } from "@/features/projects";
import { ArrowLeft, Search, SquarePen } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { SettingsNav } from "@/components/settings/SettingsNav";
import type { SettingsSection } from "@/components/settings/settings-nav";
import { useUiStore } from "@/stores/uiStore";
import { SidebarHeader } from "@/components/shell/SidebarHeader";
import { cn } from "@/lib/utils";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
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

function SettingsBackRow({ onCloseSettings }: { onCloseSettings: (() => void) | undefined }) {
  return <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/40 px-2">
    <Button variant="ghost" size="icon-compact" onClick={onCloseSettings} aria-label="Back to chat" className="text-muted"><ArrowLeft size={15} /></Button><span className="text-sm font-semibold text-muted">Settings</span>
  </div>;
}

function getSettingsNavProps(settingsOpen: boolean | undefined, settingsSection: SettingsSection | undefined, onSettingsSection: ((section: SettingsSection) => void) | undefined): { section: SettingsSection; onSection: (section: SettingsSection) => void } | null {
  return settingsOpen && settingsSection && onSettingsSection ? { section: settingsSection, onSection: onSettingsSection } : null;
}

function SidebarGoZone() {
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);
  return <div className="flex shrink-0 items-center gap-2 px-3">
    <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control bg-panel px-2 text-left text-body-small text-muted transition-colors duration-(--duration-fast) hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus" onClick={() => useCommandPaletteStore.getState().open({ intent: "threadSearch" })}>
      <Search size={16} aria-hidden className="shrink-0" />
      <span>Search</span>
    </button>
    <IconButton data-testid="sidebar-new-thread" aria-label="New thread" onClick={() => { setPrimarySurface("chat"); useWorkspaceStore.getState().beginNewThread(); }}>
      <SquarePen aria-hidden />
    </IconButton>
  </div>;
}

function SidebarBody({ settingsOpen, settingsSection, onSettingsSection }: { settingsOpen: boolean | undefined; settingsSection: SettingsSection | undefined; onSettingsSection: ((section: SettingsSection) => void) | undefined }) {
  const settingsNavProps = getSettingsNavProps(settingsOpen, settingsSection, onSettingsSection);
  if (settingsNavProps) {
    return <div data-testid="sidebar-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain"><SettingsNav {...settingsNavProps} /></div>;
  }
  return <>
    <SidebarGoZone />
    <div data-testid="sidebar-body" className="flex min-h-0 flex-1 flex-col overflow-hidden px-1.5"><ProjectTree /></div>
  </>;
}

// Only this frame reads the width, so a seam drag re-renders one div rather than the project tree.
function SidebarFrame({ settingsOpen, className, children }: { settingsOpen: boolean | undefined; className: string | undefined; children: ReactNode }) {
  const width = useSidebarWidthStore((s) => s.width);
  return <div data-testid="sidebar" style={{ width }} className={cn("flex h-full flex-col gap-4 bg-page pb-3", settingsOpen ? "max-w-[42vw] md:max-w-none" : "max-w-[55vw] md:max-w-none", className)}>
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
      {settingsOpen ? <SettingsBackRow onCloseSettings={onCloseSettings} /> : null}
      <SidebarBody settingsOpen={settingsOpen} settingsSection={settingsSection} onSettingsSection={onSettingsSection} />
      <SidebarFooter settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} />
    </SidebarFrame>
  );
}
