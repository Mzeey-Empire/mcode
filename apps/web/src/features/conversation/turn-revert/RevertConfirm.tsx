import { useEffect, useRef, type KeyboardEvent } from "react";
import type { TurnRevertPreview } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { failureCopy, previewBlockedReason, revertWarning, unattributedNote } from "./revert-copy";
import type { TurnRevertState } from "./useTurnRevert";

type ReadyPreview = Extract<TurnRevertPreview, { status: "ready" }>;

/** Props for {@link RevertConfirm}. */
export interface RevertConfirmProps {
  readonly state: TurnRevertState;
  /** The question for a ready preview. Revert this turn and Revert file word it differently. */
  readonly title: (preview: ReadyPreview) => string;
  /** The warning under a ready preview's title. Defaults to the later-edit warning. */
  readonly body?: (preview: ReadyPreview) => string | null;
  readonly onRevert: () => void;
  readonly onCancel: () => void;
}

interface ConfirmCopy {
  readonly title: string;
  readonly body: string | null;
  readonly note: string | null;
  readonly action: "revert" | "retry" | "close";
}

type FailedState = Extract<TurnRevertState, { phase: "failed" }>;

function failedCopy(state: FailedState, title: RevertConfirmProps["title"]): ConfirmCopy {
  const { text, retry } = state.failure.status === "error"
    ? { text: `Couldn't revert · ${state.failure.detail}`, retry: true }
    : failureCopy(state.failure);
  const ready = state.preview?.status === "ready" ? state.preview : null;
  return { title: ready ? title(ready) : "Couldn't revert", body: text, note: null, action: retry && ready ? "retry" : "close" };
}

function confirmCopy(state: TurnRevertState, title: RevertConfirmProps["title"], body: NonNullable<RevertConfirmProps["body"]>): ConfirmCopy {
  if (state.phase === "loading") return { title: "Checking files…", body: null, note: null, action: "revert" };
  if (state.phase === "failed") return failedCopy(state, title);
  const preview = state.preview;
  const blocked = previewBlockedReason(preview);
  if (blocked !== null || preview.status !== "ready") return { title: blocked ?? "", body: null, note: null, action: "close" };
  return { title: title(preview), body: body(preview), note: unattributedNote(preview), action: "revert" };
}

/**
 * Inline confirm under a changes bar. Revert stays disabled until the preview
 * arrives, focus starts on Cancel, and Esc cancels.
 */
export function RevertConfirm({ state, title, body = revertWarning, onRevert, onCancel }: RevertConfirmProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const copy = confirmCopy(state, title, body);
  const applying = state.phase === "preview" && state.applying;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onCancel();
  };

  return (
    <div
      role="group"
      aria-label="Confirm revert"
      onKeyDown={onKeyDown}
      className="flex flex-col gap-2.5 rounded-control border border-error/35 bg-panel px-3.5 py-3"
      data-testid="revert-confirm"
    >
      <div className="flex flex-col gap-2.5" aria-live="polite" aria-atomic="true">
        <p className="text-body-small font-medium text-ink">{copy.title}</p>
        {copy.body && <p className="text-body-small text-muted">{copy.body}</p>}
        {copy.note && <p className="text-body-small text-muted">{copy.note}</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button ref={cancelRef} variant="ghost" shape="round" className="px-3.5" onClick={onCancel}>
          {copy.action === "close" ? "Close" : "Cancel"}
        </Button>
        {copy.action !== "close" && (
          <Button
            variant="destructive"
            shape="round"
            className="px-3.5"
            disabled={state.phase === "loading"}
            loading={applying}
            onClick={onRevert}
          >
            {copy.action === "retry" ? "Retry" : "Revert"}
          </Button>
        )}
      </div>
    </div>
  );
}
