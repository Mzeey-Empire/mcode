import { Braces, ExternalLink, GitPullRequest, Settings } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { useUiStore } from "@/stores/uiStore";
import { ProvidersBell } from "./ProvidersBell";
import { UpdateButton } from "./UpdateButton";

/** Props for {@link SidebarFooter}. */
interface SidebarFooterProps {
  /** Whether the settings view is active; the footer then offers the raw settings file instead. */
  settingsOpen: boolean | undefined;
  /** Opens the settings view. */
  onOpenSettings: () => void;
}

/** True when running inside the Electron shell. */
const IS_DESKTOP = typeof window !== "undefined" && !!window.desktopBridge;

/** Bottom strip of the sidebar: Settings, Pull requests and Providers icons, with the update slot on the right. */
export function SidebarFooter({ settingsOpen, onOpenSettings }: SidebarFooterProps) {
  if (settingsOpen) return <SettingsFileFooter />;
  return (
    <footer data-testid="sidebar-footer" className="flex shrink-0 items-center justify-between gap-1 px-3">
      <div className="flex items-center gap-1">
        <IconButton aria-label="Settings" onClick={onOpenSettings}>
          <Settings strokeWidth={1.5} aria-hidden />
        </IconButton>
        <PullRequestsButton />
        <ProvidersBell />
      </div>
      <div data-testid="sidebar-update-slot" className="flex min-w-0 justify-end">
        <UpdateButton />
      </div>
    </footer>
  );
}

function PullRequestsButton() {
  const active = useUiStore((s) => s.primarySurface === "pullRequests");
  const setPrimarySurface = useUiStore((s) => s.setPrimarySurface);
  return (
    <IconButton
      aria-label="Pull requests"
      pressed={active}
      aria-current={active ? "page" : undefined}
      onClick={() => setPrimarySurface("pullRequests")}
    >
      <GitPullRequest strokeWidth={1.5} aria-hidden />
    </IconButton>
  );
}

function SettingsFileFooter() {
  return (
    <footer data-testid="sidebar-footer" className="shrink-0 space-y-1 px-3">
      <UpdateButton />
      {IS_DESKTOP && <Button
        variant="ghost"
        className="w-full justify-start text-muted hover:text-ink"
        onClick={() => void window.desktopBridge?.openSettingsFile()}
      >
        <Braces aria-hidden />
        Edit settings.json
        <ExternalLink size={11} aria-hidden />
      </Button>}
    </footer>
  );
}
