import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { executeCommand } from "@/lib/command-registry";
import { useShellChrome } from "./shell-chrome-context";

/**
 * Empty slot under the macOS traffic lights. It leaves the layout everywhere else and in full
 * screen, because a 0-wide flex item still takes a gap and pushes the next control inward.
 */
export function TrafficLightsReserve() {
  return (
    <div
      aria-hidden
      className="hidden h-full shrink-0 [:root[data-window-chrome=traffic-lights]:not([data-full-screen])_&]:block"
      style={{ width: "var(--traffic-lights-reserve)" }}
    />
  );
}

/** Sidebar toggle in a window header. */
export function SidebarToggleButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-compact" aria-label={label} className="text-muted" onClick={onClick}>
      <PanelLeft size={16} aria-hidden />
    </Button>
  );
}

/** Back and forward through navigation history. */
export function HistoryButtons() {
  const { canGoBack, canGoForward } = useShellChrome();
  return (
    <>
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label="Back"
        className="text-muted"
        disabled={!canGoBack}
        onClick={() => executeCommand("navigation.back")}
      >
        <ArrowLeft size={16} aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label="Forward"
        className="text-muted"
        disabled={!canGoForward}
        onClick={() => executeCommand("navigation.forward")}
      >
        <ArrowRight size={16} aria-hidden />
      </Button>
    </>
  );
}
