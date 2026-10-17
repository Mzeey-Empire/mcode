import { Button } from "@/components/ui/button";

/** Paper's card buttons are 14px padded, between the shared compact and default sizes. */
const CARD_BUTTON = "px-3.5 text-body-small";

interface ActionApprovalCardProps {
  readonly actionName: string;
  /** The exact command the approval is bound to, so the user reviews what will run. */
  readonly script: string;
  readonly starting: boolean;
  readonly error: string | null;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}

/**
 * Asks the user to approve a shared Project Action before its terminal runs anything.
 * It fills the pending terminal's surface because that terminal has no process to show.
 */
export function ActionApprovalCard({ actionName, script, starting, error, onRun, onCancel }: ActionApprovalCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-panel p-3.5">
      <div className="flex flex-col gap-1">
        <p className="text-sm/[18px] font-semibold text-ink">Run {actionName}?</p>
        <p className="text-body-small text-muted">
          This action comes from .mcode/environment.json in the repo. It runs once you approve it.
        </p>
      </div>
      <pre
        tabIndex={0}
        aria-label="Command to approve"
        className="max-h-48 overflow-auto rounded-lg bg-page px-3 py-2.5 font-mono text-xs/[18px] whitespace-pre-wrap break-words text-ink"
      >
        {script}
      </pre>
      {error ? <p role="alert" className="text-body-small text-error">{error}</p> : null}
      <div className="flex gap-2">
        <Button variant="ink" shape="round" autoFocus disabled={starting} className={`${CARD_BUTTON} font-semibold`} onClick={onRun}>
          Run
        </Button>
        <Button variant="subtle" shape="round" disabled={starting} className={CARD_BUTTON} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
