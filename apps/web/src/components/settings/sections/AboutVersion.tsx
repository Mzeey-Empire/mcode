import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readActiveAgentCount } from "@/features/updates/active-agent-count";
import { releaseNotesUrl, type FailedUpdateOperation } from "@/features/updates/update-button-state";
import { friendlyUpdateError } from "@/lib/update-error-message";
import { useSettingsStore } from "@/stores/settingsStore";
import { getExecutingThreadIds, useThreadStore } from "@/stores/threadStore";
import { useUpdateStore } from "@/stores/updateStore";
import type { UpdateStatus } from "@/transport/desktop-bridge";
import type { BuildStage } from "@mcode/contracts/build-stage";
import { SettingRowFrame } from "../Setting";
import type { SettingRowProps } from "../setting-def";
import { HoldToRestartButton } from "./HoldToRestartButton";

/**
 * Where the update stands, as the Version row tells it. Each variant owns one status sentence and one action.
 * `next` is null only while downloading an update whose version the store never saw.
 * A ready update's `runningAgents` is null when the server count is unknown, so agents may be running.
 */
export type VersionPhase =
  | { readonly kind: "up-to-date" }
  | { readonly kind: "checks-off" }
  | { readonly kind: "checking" }
  | { readonly kind: "available"; readonly next: string }
  | { readonly kind: "downloading"; readonly next: string | null; readonly percent: number }
  | { readonly kind: "ready"; readonly next: string; readonly runningAgents: number | null }
  | { readonly kind: "when-idle"; readonly next: string }
  | { readonly kind: "failed"; readonly operation: FailedUpdateOperation; readonly message: string; readonly runningAgents: number | null };

/** Renderer facts the desktop status cannot carry. */
export interface VersionPhaseContext {
  /** True while a check the user started is in flight, before the desktop pushes its own status. */
  readonly checking: boolean;
  readonly checksOff: boolean;
  readonly pendingVersion: string | null;
  /** Running threads this window has loaded. */
  readonly runningAgents: number;
  /** The server's count across every window; null when it was unreadable or late. */
  readonly serverAgents: number | null;
}

/** Maps the desktop update status to the phase the Version row shows. */
export function deriveVersionPhase(status: UpdateStatus, context: VersionPhaseContext): VersionPhase {
  if (context.checking) return { kind: "checking" };
  switch (status.state) {
    case "checking":
      return { kind: "checking" };
    case "available":
      return { kind: "available", next: status.version };
    case "downloading":
      return { kind: "downloading", next: context.pendingVersion, percent: Math.round(status.percent) };
    case "downloaded":
      return downloadedPhase(status, readyAgents(context));
    case "error":
      return { kind: "failed", operation: status.failedOperation, message: status.message, runningAgents: readyAgents(context) };
    case "idle":
    case "not-available":
      return restingPhase(status, context.checksOff);
  }
}

// The server sees agents this window has not loaded; the local count can be ahead of a stale server read.
function readyAgents({ runningAgents, serverAgents }: VersionPhaseContext): number | null {
  if (serverAgents === null) return runningAgents > 0 ? runningAgents : null;
  return Math.max(runningAgents, serverAgents);
}

function downloadedPhase(status: Extract<UpdateStatus, { state: "downloaded" }>, runningAgents: number | null): VersionPhase {
  return status.installWhenIdle ? { kind: "when-idle", next: status.version } : { kind: "ready", next: status.version, runningAgents };
}

// A check that found nothing proves the app is current even with automatic checks off.
function restingPhase(status: Extract<UpdateStatus, { state: "idle" | "not-available" }>, checksOff: boolean): VersionPhase {
  return status.state === "idle" && checksOff ? { kind: "checks-off" } : { kind: "up-to-date" };
}

function pendingVersionOf(phase: VersionPhase): string | null {
  switch (phase.kind) {
    case "available":
    case "downloading":
    case "ready":
    case "when-idle":
      return phase.next;
    default:
      return null;
  }
}

function agentsText(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

function failureSentence(message: string): string {
  const friendly = friendlyUpdateError(message);
  return `${friendly.title}. ${friendly.body}`;
}

function announceReady({ next, runningAgents }: Extract<VersionPhase, { kind: "ready" }>): string {
  return runningAgents === 0 ? `v${next} is ready to install` : `v${next} is ready. ${readyConsequence(runningAgents)}`;
}

/** Plain sentence for the visually hidden status line; screen readers hear it when the phase changes. */
export function announceVersionPhase(phase: VersionPhase): string {
  switch (phase.kind) {
    case "up-to-date":
      return "Up to date";
    case "checks-off":
      return "Automatic checks off";
    case "checking":
      return "Checking for updates";
    case "available":
      return `v${phase.next} is available`;
    case "downloading":
      return phase.next ? `Downloading v${phase.next}` : "Downloading update";
    case "ready":
      return announceReady(phase);
    case "when-idle":
      return `v${phase.next} installs when your agents finish`;
    case "failed":
      return failureSentence(phase.message);
  }
}

function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

function readyConsequence(runningAgents: number | null): string {
  if (runningAgents === null) return "Agents may be running.";
  return runningAgents > 0 ? `Restarting ends ${agentsText(runningAgents)}.` : "Restart Mcode to install it.";
}

function VersionHint({ phase }: { readonly phase: VersionPhase }) {
  switch (phase.kind) {
    case "up-to-date":
      return "Up to date.";
    case "checks-off":
      return "Automatic checks are off.";
    case "checking":
      return "Checking for updates.";
    case "available":
      return <><Mono>v{phase.next}</Mono> is available.</>;
    case "downloading":
      return <>Downloading {phase.next ? <Mono>v{phase.next}</Mono> : "update"}, <Mono>{phase.percent}%</Mono>.</>;
    case "ready":
      return <><Mono>v{phase.next}</Mono> is ready. {readyConsequence(phase.runningAgents)}</>;
    case "when-idle":
      return <>Installs <Mono>v{phase.next}</Mono> when your agents finish.</>;
    case "failed":
      return failureSentence(phase.message);
  }
}

type DesktopAppBridge = NonNullable<Window["desktopBridge"]>["app"];

interface VersionActions {
  readonly check: () => void;
  readonly download: () => void;
  readonly restart: () => void;
  /** Restarts only if the server still counts no agents; otherwise records the count so the row asks for a hold. */
  readonly restartIfIdle: () => void;
  readonly installWhenIdle: () => void;
  readonly cancelWhenIdle: () => void;
}

function useVersionActions(
  app: DesktopAppBridge,
  setChecking: (checking: boolean) => void,
  setServerAgents: (count: number | null) => void,
): VersionActions {
  const restart = async () => {
    const started = await app.installUpdate().catch((error: unknown) => {
      console.error("[updates] installUpdate failed", error);
      return false;
    });
    if (started) return;
    // The desktop publishes why it refused; reading it back shows Retry even if that push was missed.
    useUpdateStore.getState().setStatus(await app.getUpdateStatus());
  };
  // The plain Restart may rest on a stale count; another window can have started agents since.
  const restartIfIdle = async () => {
    const count = await readActiveAgentCount();
    if (count === 0) return restart();
    setServerAgents(count);
  };
  const check = async () => {
    setChecking(true);
    try {
      await app.checkForUpdates();
    } catch {
      // The main process broadcasts the failure as an error status, which the row then shows.
    } finally {
      setChecking(false);
    }
  };
  return {
    check: () => void check(),
    download: () => void app.downloadUpdate(),
    restart: () => void restart(),
    restartIfIdle: () => void restartIfIdle(),
    installWhenIdle: () => void app.installWhenIdle(),
    cancelWhenIdle: () => void app.cancelInstallWhenIdle(),
  };
}

const RETRY: Record<FailedUpdateOperation, keyof VersionActions> = { check: "check", download: "download", install: "restartIfIdle" };

function holdName(runningAgents: number | null): string {
  if (runningAgents === null) return "Hold to restart. Agents may be running.";
  return `Hold to restart. Ends ${runningAgents === 1 ? "1 running agent" : `${runningAgents} running agents`}.`;
}

function ActionButton({ children, onClick, disabled }: { readonly children: string; readonly onClick: () => void; readonly disabled?: boolean }) {
  // aria-disabled keeps the button focusable while a check runs, so focus does not jump away.
  return (
    <Button variant="outline" aria-disabled={disabled || undefined} onClick={disabled ? undefined : onClick}>
      {children}
    </Button>
  );
}

// Restarting ends running agents, so with agents running it asks for a held press instead of a dialog.
function ReadyAction({ runningAgents, actions }: { readonly runningAgents: number | null; readonly actions: VersionActions }) {
  if (runningAgents === 0) return <ActionButton onClick={actions.restartIfIdle}>Restart</ActionButton>;
  return (
    <span className="inline-flex">
      <Button variant="outline" className="rounded-r-none" onClick={actions.installWhenIdle}>
        Install when they finish
      </Button>
      <HoldToRestartButton className="-ml-px rounded-l-none" accessibleName={holdName(runningAgents)} onCommit={actions.restart} />
    </span>
  );
}

function RetryAction({ phase, actions }: { readonly phase: Extract<VersionPhase, { kind: "failed" }>; readonly actions: VersionActions }) {
  if (phase.operation === "install" && phase.runningAgents !== 0) {
    return <HoldToRestartButton accessibleName={holdName(phase.runningAgents)} onCommit={actions.restart} />;
  }
  return <ActionButton onClick={actions[RETRY[phase.operation]]}>Retry</ActionButton>;
}

function VersionAction({ phase, actions }: { readonly phase: VersionPhase; readonly actions: VersionActions }) {
  switch (phase.kind) {
    case "up-to-date":
    case "checks-off":
      return <ActionButton onClick={actions.check}>Check now</ActionButton>;
    case "checking":
      return <ActionButton onClick={actions.check} disabled>Check now</ActionButton>;
    case "available":
      return <ActionButton onClick={actions.download}>Download</ActionButton>;
    case "downloading":
      // The updater cannot cancel a download, so there is nothing to offer until it lands.
      return null;
    case "ready":
      return <ReadyAction runningAgents={phase.runningAgents} actions={actions} />;
    case "when-idle":
      return <ActionButton onClick={actions.cancelWhenIdle}>Cancel</ActionButton>;
    case "failed":
      return <RetryAction phase={phase} actions={actions} />;
  }
}

function WhatsNewLink({ version }: { readonly version: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`What's new in v${version}`}
            className="inline-flex items-center gap-1 text-caption font-normal text-link hover:text-focus focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus"
            onClick={() => void window.desktopBridge?.openExternalUrl(releaseNotesUrl(version))}
          />
        }
      >
        What&apos;s new
        <ExternalLink aria-hidden className="size-3" />
      </TooltipTrigger>
      <TooltipContent>Release notes for v{version}</TooltipContent>
    </Tooltip>
  );
}

const STAGE_LABEL: Record<BuildStage, string | null> = { dev: "Dev", nightly: "Nightly", stable: null };

function VersionLabel({ notesVersion }: { readonly notesVersion: string | null }) {
  const version = useUpdateStore((s) => s.version);
  const stage = useUpdateStore((s) => s.stage);
  const stageLabel = stage ? STAGE_LABEL[stage] : null;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <span>Version</span>
      <span className="font-mono font-normal text-muted tabular-nums">{version ? `v${version}` : "Unknown"}</span>
      {stageLabel && <span className="font-normal text-muted">{stageLabel}</span>}
      {notesVersion && <WhatsNewLink version={notesVersion} />}
    </span>
  );
}

function useRunningAgentCount(): number {
  return useThreadStore((s) => getExecutingThreadIds(s).length);
}

// Reads the server's count while an update is ready, and again whenever this window's count moves.
// Until the first read lands it counts 0; a plain Restart re-checks before installing anyway.
function useServerAgentCount(ready: boolean, runningAgents: number) {
  const [count, setCount] = useState<number | null>(0);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    void readActiveAgentCount().then((next) => {
      if (current) setCount(next);
    });
    return () => {
      current = false;
    };
  }, [ready, runningAgents]);
  return { count, set: setCount };
}

function DesktopVersionRow({ def, variant, app }: SettingRowProps & { readonly app: DesktopAppBridge }) {
  const status = useUpdateStore((s) => s.status);
  const pendingVersion = useUpdateStore((s) => s.pendingVersion);
  const checksOff = useSettingsStore((s) => s.settings.updates?.checkInterval === "never");
  const runningAgents = useRunningAgentCount();
  const installPending = (status.state === "downloaded" && !status.installWhenIdle) || (status.state === "error" && status.failedOperation === "install");
  const serverAgents = useServerAgentCount(installPending, runningAgents);
  const [checking, setChecking] = useState(false);
  const actions = useVersionActions(app, setChecking, serverAgents.set);
  const phase = deriveVersionPhase(status, { checking, checksOff, pendingVersion, runningAgents, serverAgents: serverAgents.count });
  return (
    <SettingRowFrame def={def} variant={variant} label={<VersionLabel notesVersion={pendingVersionOf(phase)} />} hint={<VersionHint phase={phase} />}>
      <VersionAction phase={phase} actions={actions} />
      <span role="status" className="sr-only">{announceVersionPhase(phase)}</span>
    </SettingRowFrame>
  );
}

/**
 * Version row: the installed version, where the update stands, and the one action that moves it on.
 * Outside the desktop shell there is no updater, so it shows only the version.
 */
export function VersionRow({ def, variant }: SettingRowProps) {
  const app = typeof window !== "undefined" ? window.desktopBridge?.app : undefined;
  if (!app) {
    return (
      <SettingRowFrame def={def} variant={variant} label={<VersionLabel notesVersion={null} />}>
        {null}
      </SettingRowFrame>
    );
  }
  return <DesktopVersionRow def={def} variant={variant} app={app} />;
}
