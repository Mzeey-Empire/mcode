import { ArrowLeft, Braces, ExternalLink, GitPullRequest, Settings } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SETTINGS_SIDEBAR_ROW_CLASS } from "@/components/settings/settings-sidebar-row";
import { useUiStore } from "@/stores/uiStore";
import { ProvidersBell } from "./ProvidersBell";
import { UpdateButton } from "./UpdateButton";

/** Props for {@link SidebarFooter}. */
interface SidebarFooterProps {
  /** Whether the settings view is active; the footer then offers the raw settings file instead. */
  settingsOpen: boolean | undefined;
  /** Opens the settings view. */
  onOpenSettings: () => void;
  /** Closes the settings view. */
  onCloseSettings?: (() => void) | undefined;
}

/** True when running inside the Electron shell. */
const IS_DESKTOP = typeof window !== "undefined" && !!window.desktopBridge;

/** Bottom strip of the sidebar: Settings, Pull requests and Providers icons, with the update slot on the right. */
export function SidebarFooter({ settingsOpen, onOpenSettings, onCloseSettings }: SidebarFooterProps) {
  if (settingsOpen) return <SettingsFileFooter onCloseSettings={onCloseSettings} />;
  return (
    <footer data-testid="sidebar-footer" className="flex shrink-0 items-center justify-between gap-1 px-1.5">
      <div className="flex items-center gap-1">
        <IconButton aria-label="Settings" onClick={onOpenSettings}>
          <Settings aria-hidden />
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
      <GitPullRequest aria-hidden />
    </IconButton>
  );
}

function SettingsFileFooter({ onCloseSettings }: { onCloseSettings: (() => void) | undefined }) {
  return (
    <footer data-testid="sidebar-footer" className="shrink-0 space-y-1 px-2">
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
      {/* Settings opened from the bottom of the app sidebar, so the way back sits in that same spot. */}
      <Tooltip>
        <TooltipTrigger render={<button type="button" aria-label="Close Settings" onClick={onCloseSettings} className={SETTINGS_SIDEBAR_ROW_CLASS} />}>
          <ArrowLeft size={16} aria-hidden className="shrink-0" />
          <span aria-hidden>Settings</span>
        </TooltipTrigger>
        <TooltipContent side="top">Back to app</TooltipContent>
      </Tooltip>
    </footer>
  );
}
