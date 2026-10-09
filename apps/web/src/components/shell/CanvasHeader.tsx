import type { ReactNode } from "react";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUiStore } from "@/stores/uiStore";
import { useShellChrome } from "./shell-chrome-context";
import { HistoryButtons, SidebarToggleButton, TrafficLightsReserve } from "./ShellControls";

/** Shows a busy notice while the WebSocket reconnects or re-authenticates. */
function ConnectionNotice() {
  const status = useConnectionStore((s) => s.status);
  if (status !== "reconnecting" && status !== "authFailed") return null;
  const title = status === "authFailed" ? "Re-authenticating after server restart" : "Reconnecting to server";
  return <div className="px-4 pt-2"><Notice tone="warning" busy title={title} /></div>;
}

/** Sidebar controls the canvas takes over while the sidebar is not docked. */
function CollapsedSidebarControls() {
  const expandSidebar = useUiStore((s) => s.expandSidebar);
  return (
    <div className="flex shrink-0 items-center gap-1 self-stretch">
      <TrafficLightsReserve />
      <SidebarToggleButton label="Expand sidebar" onClick={expandSidebar} />
      <HistoryButtons />
    </div>
  );
}

/**
 * Top row of the main canvas. Empty space drags the window, and the right edge
 * leaves room for the native caption buttons on Windows and Linux.
 */
export function CanvasHeader({ children, className }: { readonly children?: ReactNode; readonly className?: string }) {
  const { sidebarDocked } = useShellChrome();
  return (
    <>
      <header
        data-canvas-header=""
        className={cn("window-drag flex h-row-comfortable shrink-0 items-center gap-4 pl-4 select-none", className)}
      >
        {sidebarDocked ? null : <CollapsedSidebarControls />}
        {children}
      </header>
      <ConnectionNotice />
    </>
  );
}

/**
 * Top strip of the right panel. It keeps panel content clear of the
 * Windows/Linux caption buttons, and takes over the sidebar controls when a
 * maximized panel has replaced the canvas and the sidebar is not docked.
 */
export function PanelCaptionStrip({ maximized }: { readonly maximized: boolean }) {
  const { sidebarDocked } = useShellChrome();
  if (!maximized || sidebarDocked) return <div aria-hidden className="caption-strip window-drag" />;
  return (
    <header className="window-drag flex h-row-comfortable shrink-0 items-center pl-4 select-none">
      <CollapsedSidebarControls />
    </header>
  );
}
