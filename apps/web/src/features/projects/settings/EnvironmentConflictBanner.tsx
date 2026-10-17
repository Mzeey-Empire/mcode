import { Button } from "@/components/ui/button";
import type { WorkspaceEnvironmentStorageMode } from "@mcode/contracts";

interface EnvironmentConflictBannerProps {
  readonly storageMode: WorkspaceEnvironmentStorageMode;
  readonly busy: boolean;
  readonly onKeepMine: () => void;
  readonly onReload: () => void;
}

/** Shown above the list when the saved file changed under unsaved edits. */
export function EnvironmentConflictBanner({ storageMode, busy, onKeepMine, onReload }: EnvironmentConflictBannerProps) {
  const shared = storageMode === "shared";
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-[10px] bg-panel py-2.5 pr-2 pl-3 shadow-[inset_0_0_0_1px_var(--color-primary)]"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px]/[18px] text-ink">
          {shared ? ".mcode/environment.json changed on disk" : "Actions changed in another window"}
        </span>
        {shared ? <span className="text-caption text-muted">A pull or another thread edited it.</span> : null}
      </div>
      <Button variant="subtle" shape="round" disabled={busy} className="h-7 px-3 text-caption font-medium" onClick={onKeepMine}>Keep mine</Button>
      <Button variant="ink" shape="round" disabled={busy} className="h-7 px-3 text-caption font-semibold" onClick={onReload}>Reload</Button>
    </div>
  );
}
