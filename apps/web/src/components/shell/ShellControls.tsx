import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { executeCommand } from "@/lib/command-registry";
import { useShellChrome } from "./shell-chrome-context";

/** Empty slot under the macOS traffic lights; 0 wide everywhere else and in full screen. */
export function TrafficLightsReserve() {
  return <div aria-hidden className="h-full shrink-0" style={{ width: "var(--traffic-lights-reserve)" }} />;
}

/** Sidebar toggle in a window header. */
export function SidebarToggleButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-compact" aria-label={label} className="text-muted" onClick={onClick}>
      <PanelLeft size={16} strokeWidth={1.5} aria-hidden />
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
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label="Forward"
        className="text-muted"
        disabled={!canGoForward}
        onClick={() => executeCommand("navigation.forward")}
      >
        <ArrowRight size={16} strokeWidth={1.5} aria-hidden />
      </Button>
    </>
  );
}
