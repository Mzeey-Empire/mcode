import { Button } from "@/components/ui/button";

interface SettingsSaveBarProps {
  /** A document-level problem that explains why Save is off, shown in place of the default label. */
  readonly problem: string | null;
  readonly canSave: boolean;
  readonly busy: boolean;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}

/** Appears only while there are unsaved edits. */
export function SettingsSaveBar({ problem, canSave, busy, onDiscard, onSave }: SettingsSaveBarProps) {
  return (
    <div role="region" aria-label="Unsaved changes" className="flex h-[52px] shrink-0 items-center gap-2 border-t border-border pr-2 pl-4">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
      <span className={problem ? "min-w-0 flex-1 text-fade text-body-small text-error" : "min-w-0 flex-1 text-body-small text-ink"}>
        {problem ?? "Unsaved changes"}
      </span>
      <Button variant="subtle" shape="round" disabled={busy} className="px-3.5 text-body-small font-medium" onClick={onDiscard}>Discard</Button>
      <Button variant="ink" shape="round" disabled={!canSave || busy} loading={busy} className="px-3.5 text-body-small font-semibold" onClick={onSave}>Save</Button>
    </div>
  );
}
