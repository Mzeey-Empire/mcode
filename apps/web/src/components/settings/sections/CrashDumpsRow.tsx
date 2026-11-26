import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { formatAttachmentByteSize } from "@/components/chat/attachment-display";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Switch } from "@/components/ui/switch";
import { TooltipTrigger } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settingsStore";
import type { CrashDumpsState } from "@/transport/desktop-bridge";
import { PathTooltipRoot, usePathTooltip } from "../PathLine";
import { SettingRowFrame } from "../Setting";
import type { SettingRowProps } from "../setting-def";

function crashDumpsBridge() {
  return typeof window !== "undefined" ? window.desktopBridge?.app : undefined;
}

/** True when the desktop app can report, delete, and apply (by restarting) crash dumps; false in the web app. */
export function crashDumpsAvailable(): boolean {
  const bridge = crashDumpsBridge();
  return Boolean(bridge?.getCrashDumps && bridge.deleteCrashDumps && bridge.relaunch);
}

// Fixed text, never the rejection's message: Electron prefixes IPC failures with "Error invoking remote method"
// and appends raw errno text, which tells the user nothing they can act on.
const READ_FAILED = "Couldn't read the crash dumps folder. Reopen this page to try again.";
const DELETE_FAILED = "Couldn't delete every crash dump. Close anything using them, then try again.";

/** FieldError's look as a span, because the row hint is a paragraph and FieldError is one too. */
function LoadError({ message }: { readonly message: string }) {
  return (
    <span role="alert" className="mt-1 flex items-center gap-1 text-caption text-error">
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      {message}
    </span>
  );
}

function DeleteCrashDumpsDialog({ state, error, onDelete, onKeep }: { readonly state: CrashDumpsState; readonly error: string | null; readonly onDelete: () => void; readonly onKeep: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onKeep()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete crash dumps?</DialogTitle>
          <DialogDescription>Removes {formatAttachmentByteSize(state.totalBytes)}. This can't be undone.</DialogDescription>
        </DialogHeader>
        {error ? <FieldError role="alert">{error}</FieldError> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onKeep}>Keep</Button>
          <Button variant="destructive" onClick={onDelete}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Crash dumps row: a switch, a Restart button once the saved value differs from the one this launch
 * started with, and where the dumps are kept with their size. Switching off while dumps exist offers to delete them.
 */
export function CrashDumpsRow({ def, variant }: SettingRowProps) {
  const bridge = crashDumpsBridge();
  const saved = useSettingsStore((s) => s.settings.diagnostics?.crashDumps ?? false);
  const updateSettings = useSettingsStore((s) => s.update);
  const pathTooltip = usePathTooltip();
  const [state, setState] = useState<CrashDumpsState | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge?.getCrashDumps?.().then(
      (loaded) => {
        if (!cancelled) setState(loaded);
      },
      () => {
        if (!cancelled) setLoadError(READ_FAILED);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function refresh(): Promise<CrashDumpsState | undefined> {
    try {
      const fresh = await bridge?.getCrashDumps?.();
      if (fresh) {
        setState(fresh);
        setLoadError(null);
      }
      return fresh;
    } catch {
      setLoadError(READ_FAILED);
      return undefined;
    }
  }

  async function handleCheckedChange(value: boolean) {
    const saveFailure = await updateSettings({ diagnostics: { crashDumps: value } });
    if (saveFailure !== undefined || value) return;
    // The state loaded at mount can predate the click or a crash since, so the offer reads fresh sizes.
    const fresh = await refresh();
    if (fresh && fresh.totalBytes > 0) setConfirmingDelete(true);
  }

  async function handleDelete() {
    try {
      const next = await bridge?.deleteCrashDumps?.();
      if (next) setState(next);
      setDeleteError(null);
      setConfirmingDelete(false);
    } catch {
      setDeleteError(DELETE_FAILED);
      await refresh();
    }
  }

  function handleKeep() {
    setDeleteError(null);
    setConfirmingDelete(false);
  }

  const needsRestart = state !== null && state.enabledAtLaunch !== saved;
  const status = state && (
    <span className="mt-1 flex min-w-0 items-baseline gap-3">
      <span className="shrink-0 text-caption text-muted"><span className="font-mono text-ink">{formatAttachmentByteSize(state.totalBytes)}</span> saved</span>
      <TooltipTrigger handle={pathTooltip} payload={state.directory} render={
        <span aria-label={state.directory} className="min-w-0 break-all font-mono text-caption text-muted [font-variant-ligatures:none]">{state.directory}</span>
      } />
    </span>
  );

  return (
    <>
      <SettingRowFrame def={def} variant={variant} hint={<>{def.hint}{status}{loadError ? <LoadError message={loadError} /> : null}</>}>
        <div className="flex items-center justify-end gap-3">
          {needsRestart && <Button variant="secondary" size="compact" onClick={() => void bridge?.relaunch?.()}>Restart</Button>}
          <Switch aria-label="Crash dumps" checked={saved} onCheckedChange={(value) => void handleCheckedChange(value)} />
        </div>
      </SettingRowFrame>
      <PathTooltipRoot handle={pathTooltip} />
      {confirmingDelete && state && <DeleteCrashDumpsDialog state={state} error={deleteError} onDelete={() => void handleDelete()} onKeep={handleKeep} />}
    </>
  );
}
