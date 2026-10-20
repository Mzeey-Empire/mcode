import { useEffect, useRef, useState, type ReactElement } from "react";
import { Check, CircleAlert, CircleArrowDown, CircleArrowUp, RefreshCw } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger, type PopoverRootChangeEventDetails } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { friendlyUpdateError } from "@/lib/update-error-message";
import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/stores/updateStore";
import { getTransport } from "@/transport";
import { isNightlyVersion } from "@mcode/contracts";
import { deriveUpdateButtonView, type FailedUpdateOperation } from "@/features/updates/update-button-state";
import { InstallUpdateDialog } from "./InstallUpdateDialog";
import { ReleaseNotesCard } from "./ReleaseNotesCard";

/** How long "Up to date" holds after a user-started check finds nothing. */
export const UP_TO_DATE_FLASH_MS = 3_000;
/** How long Install waits for the running-agent count before asking the user instead. */
export const AGENT_COUNT_DEADLINE_MS = 3_000;
/** Hover delay before the release notes card opens. */
export const RELEASE_NOTES_HOVER_DELAY_MS = 300;

// The slot shares the footer with fixed icons, so a narrow sidebar shrinks the label and fades its end.
const SHRINK_CLASS = "min-w-0 max-w-full shrink";
// A hover card or menu sets aria-expanded; the pill keeps its fill instead of the darker toggled-on fill.
const FILLED_CLASS = cn(SHRINK_CLASS, "gap-1.5 px-2 text-caption aria-expanded:bg-selected");
const GHOST_TEXT_CLASS = cn(SHRINK_CLASS, "gap-1.5 px-2 text-caption font-normal text-muted");

interface InstallPrompt {
  readonly version: string;
  readonly runningAgents: number | null;
}

type DesktopAppBridge = NonNullable<Window["desktopBridge"]>["app"];

/**
 * Sidebar footer update control. One slot walks the whole update lifecycle:
 * check, download, install (asking first when agents are running), retry.
 * Renders nothing outside the desktop shell.
 */
export function UpdateButton() {
  const app = window.desktopBridge?.app;
  if (!app) return null;
  return <DesktopUpdateButton app={app} />;
}

function DesktopUpdateButton({ app }: { app: DesktopAppBridge }) {
  const status = useUpdateStore((s) => s.status);
  const pendingVersion = useUpdateStore((s) => s.pendingVersion);
  const [upToDateFlash, setUpToDateFlash] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [installing, setInstalling] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // State lags a render behind, so a second click in the same tick would slip past `installing`.
  const installLock = useRef(false);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // Only a check the user started may flash "Up to date"; background checks resolve silently.
  const check = async () => {
    const result = await app.checkForUpdates();
    if (result.state !== "not-available") return;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setUpToDateFlash(true);
    flashTimer.current = setTimeout(() => setUpToDateFlash(false), UP_TO_DATE_FLASH_MS);
  };

  // Held from click until the desktop answers, so a slow teardown shows progress and repeat clicks do nothing.
  const exclusiveInstall = async (work: () => Promise<void>) => {
    if (installLock.current) return;
    installLock.current = true;
    setInstalling(true);
    try {
      await work();
    } finally {
      installLock.current = false;
      setInstalling(false);
    }
  };

  const installNow = async () => {
    const started = await app.installUpdate().catch((error: unknown) => {
      console.error("[updates] installUpdate failed", error);
      return false;
    });
    if (started) return;
    // The desktop publishes why it refused; reading it back guarantees the Retry pill even if that push was missed.
    useUpdateStore.getState().setStatus(await app.getUpdateStatus());
  };

  const install = (version: string) =>
    exclusiveInstall(async () => {
      const runningAgents = await readRunningAgents();
      if (runningAgents === 0) return installNow();
      setInstallPrompt({ version, runningAgents });
    });

  const retry = (operation: FailedUpdateOperation) => {
    if (operation === "check") return void check();
    if (operation === "download") return void app.downloadUpdate();
    return void install(pendingVersion ?? "");
  };

  const view = deriveUpdateButtonView(status, { upToDateFlash, pendingVersion });

  return (
    <>
      {renderView()}
      {installPrompt && (
        <InstallUpdateDialog
          version={installPrompt.version}
          runningAgents={installPrompt.runningAgents}
          onCancel={() => setInstallPrompt(null)}
          onRestartNow={() => {
            setInstallPrompt(null);
            void exclusiveInstall(installNow);
          }}
          onInstallWhenIdle={() => {
            setInstallPrompt(null);
            void app.installWhenIdle();
          }}
        />
      )}
    </>
  );

  function renderView(): ReactElement {
    if (installing) {
      return (
        <span
          role="status"
          aria-label="Installing update"
          className={cn("inline-flex h-8 items-center rounded-control bg-selected", FILLED_CLASS)}
        >
          <Spinner size={16} className="text-muted" />
          <span className="text-fade">Installing…</span>
        </span>
      );
    }
    switch (view.kind) {
      case "rest":
        return (
          <IconButton aria-label="Check for updates" shape="round" variant="ghost" onClick={() => void check()}>
            <RefreshCw aria-hidden />
          </IconButton>
        );
      case "checking":
        return (
          <span role="status" aria-label="Checking for updates" className="flex size-8 items-center justify-center">
            <Spinner size={16} className="text-muted" />
          </span>
        );
      case "up-to-date":
        return (
          <span role="status" className={cn("inline-flex h-8 items-center", GHOST_TEXT_CLASS)}>
            <Check className="size-4 shrink-0" aria-hidden />
            <span className="text-fade">Up to date</span>
          </span>
        );
      case "download":
        return (
          <ReleaseNotesHover version={view.version} notes={view.releaseNotes} nightlyTooltip={`Download ${view.version}`}>
            <Button variant="subtle" className={FILLED_CLASS} onClick={() => void app.downloadUpdate()}>
              <CircleArrowDown aria-hidden />
              <span className="flex gap-1.5 text-fade">
                Download
                <VersionText>{view.versionLabel}</VersionText>
              </span>
            </Button>
          </ReleaseNotesHover>
        );
      case "downloading":
        return (
          <span
            role="status"
            aria-label={`Downloading update, ${Math.round(view.percent)}%`}
            className={cn("inline-flex h-8 items-center rounded-control bg-selected", FILLED_CLASS)}
          >
            <ProgressRing percent={view.percent} />
            <span className="text-fade">
              <VersionText>{view.progressLabel}</VersionText>
            </span>
          </span>
        );
      case "install":
        return (
          <ReleaseNotesHover version={view.version} notes={view.releaseNotes} nightlyTooltip={`Install ${view.version}`}>
            <Button variant="subtle" className={FILLED_CLASS} onClick={() => void install(view.version)}>
              <CircleArrowUp aria-hidden />
              <span className="flex gap-1.5 text-fade">
                Install
                <VersionText>{view.versionLabel}</VersionText>
              </span>
            </Button>
          </ReleaseNotesHover>
        );
      case "armed":
        return (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="subtle" className={FILLED_CLASS} />}>
              <CircleArrowUp aria-hidden />
              <span className="text-fade">Installs when idle</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end">
              <DropdownMenuItem label="Cancel scheduled install" onClick={() => void app.cancelInstallWhenIdle()} />
            </DropdownMenuContent>
          </DropdownMenu>
        );
      case "failed": {
        const friendly = friendlyUpdateError(view.message);
        const operation = view.failedOperation;
        return (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" className={GHOST_TEXT_CLASS} onClick={() => retry(operation)} />}>
              <CircleAlert aria-hidden />
              <span className="text-fade">Retry update</span>
            </TooltipTrigger>
            <TooltipContent className="flex-col items-start gap-0.5">
              <span className="font-medium">{friendly.title}</span>
              <span className="text-muted">{friendly.body}</span>
            </TooltipContent>
          </Tooltip>
        );
      }
    }
  }
}

// An unreadable or late count is treated as "agents may be running" so Install never silently stops work.
// The shared transport waits for its socket with no deadline, so the cap lives here.
async function readRunningAgents(): Promise<number | null> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(null), AGENT_COUNT_DEADLINE_MS);
  });
  try {
    return await Promise.race([getTransport().getActiveAgentCount(), deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function VersionText({ children }: { children: string }) {
  return <span className="font-mono text-caption font-normal text-muted">{children}</span>;
}

interface ReleaseNotesHoverProps {
  readonly version: string;
  readonly notes: string | null;
  /** Full-version tooltip, shown only for nightly builds whose label hides the version. */
  readonly nightlyTooltip: string;
  readonly children: ReactElement;
}

function ReleaseNotesHover({ version, notes, nightlyTooltip, children }: ReleaseNotesHoverProps) {
  const [open, setOpen] = useState(false);
  // Escape from inside the card hands focus back to the trigger; that focus must not reopen it.
  const escaped = useRef(false);
  // The trigger's click downloads or installs; only hover and dismissals move the card.
  const onOpenChange = (next: boolean, details: PopoverRootChangeEventDetails) => {
    if (details.reason === "trigger-press") return;
    escaped.current = details.reason === "escape-key";
    setOpen(next);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip disabled={!isNightlyVersion(version)}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              openOnHover
              delay={RELEASE_NOTES_HOVER_DELAY_MS}
              closeDelay={150}
              // Focus opens the card that hover opens, so keyboard users reach it and can Tab into it.
              // A click also focuses, but its download, dialog, or restart replaces the trigger anyway.
              onFocus={() => {
                if (!escaped.current) setOpen(true);
                escaped.current = false;
              }}
              onBlur={() => {
                escaped.current = false;
              }}
              render={children}
            />
          }
        />
        <TooltipContent side="right" className="font-mono">
          {nightlyTooltip}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={8} initialFocus={false} className="w-[340px] rounded-dialog p-4">
        <ReleaseNotesCard version={version} notes={notes} />
      </PopoverContent>
    </Popover>
  );
}

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ProgressRing({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 -rotate-90">
      <circle cx="8" cy="8" r={RING_RADIUS} fill="none" strokeWidth="1.5" className="stroke-control-border" />
      <circle
        cx="8"
        cy="8"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped / 100)}
        className="stroke-ink"
      />
    </svg>
  );
}
