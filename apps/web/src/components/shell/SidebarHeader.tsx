import { McodeLogo } from "@/components/brand/McodeLogo";
import { useUiStore } from "@/stores/uiStore";
import { HistoryButtons, SidebarToggleButton, TrafficLightsReserve } from "./ShellControls";
import { windowChromeKind } from "./window-chrome";

// macOS shows the app name in its menu bar, so the header keeps only the mark.
const SHOW_WORDMARK = windowChromeKind(
  typeof window === "undefined" ? undefined : window.desktopBridge?.window?.platform,
) !== "traffic-lights";

/** Top row of the sidebar: lights slot, toggle, logo, drag space, back and forward. */
export function SidebarHeader() {
  const collapseSidebar = useUiStore((s) => s.collapseSidebar);
  return (
    <header data-testid="sidebar-header" className="window-drag flex h-row-comfortable shrink-0 items-center gap-1 px-3 select-none">
      <TrafficLightsReserve />
      <SidebarToggleButton label="Collapse sidebar" onClick={() => collapseSidebar()} />
      <McodeLogo markOnly={!SHOW_WORDMARK} />
      <div className="min-w-0 flex-1 self-stretch" />
      <HistoryButtons />
    </header>
  );
}
