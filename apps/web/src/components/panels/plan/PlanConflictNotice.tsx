import { Button } from "@/components/ui/button";

/** Props for {@link PlanConflictNotice}. */
interface PlanConflictNoticeProps {
  /** False when the latest version is accepted, so there is nothing to save into. */
  readonly canKeep: boolean;
  readonly onKeepMine: () => void;
  readonly onUseSaved: () => void;
}

/** Asks which text wins after another window saved the plan first. */
export function PlanConflictNotice({ canKeep, onKeepMine, onUseSaved }: PlanConflictNoticeProps) {
  return (
    <div
      role="alert"
      data-testid="plan-conflict-notice"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2 text-sm"
    >
      <span className="mr-auto text-ink">This plan changed in another window.</span>
      <div className="flex gap-2">
        {canKeep && (
          <Button type="button" variant="secondary" size="compact" onClick={onKeepMine}>
            Keep my text
          </Button>
        )}
        <Button type="button" variant="ghost" size="compact" onClick={onUseSaved}>
          Use saved version
        </Button>
      </div>
    </div>
  );
}
