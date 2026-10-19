import { useState, type KeyboardEvent } from "react";
import type { ApprovalChoice } from "@mcode/contracts";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/** Row box shared by the approval and question docks. */
export const ROW_CLASS = "flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left";

/** Numbered key hint at the left of a dock row. */
export function KeyChip({ index }: { readonly index: number }) {
  return (
    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[0.5rem] border border-border px-[0.5rem] font-mono text-caption text-muted">
      {index + 1}
    </span>
  );
}

function RowSpinner() {
  return <span className="flex h-5 min-w-5 shrink-0 items-center justify-center text-primary"><Spinner size={12} /></span>;
}

/** Row styling with the dock focus ring; `focused` fills the row. */
export function choiceRowClass(focused: boolean, submitting: boolean, dimmed: boolean): string {
  return cn(ROW_CLASS, "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus", focused && "bg-hover", dimmed && "opacity-45", submitting || dimmed ? "cursor-default" : "cursor-pointer");
}

/** Props for {@link ApprovalChoiceRow}. */
export interface ApprovalChoiceRowProps {
  readonly choice: ApprovalChoice;
  readonly index: number;
  readonly focused: boolean;
  /** This row's answer is in flight. */
  readonly submitting: boolean;
  /** Another row's answer is in flight. */
  readonly dimmed: boolean;
  readonly submittingLabel: string;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
  readonly onChoose: () => void;
  readonly onFocus: () => void;
}

/**
 * One numbered adapter choice. In-flight rows use `aria-disabled` rather than
 * `disabled`, because disabling the focused button drops focus out of the dock
 * and its keys stop working.
 */
export function ApprovalChoiceRow({ choice, index, focused, submitting, dimmed, submittingLabel, buttonRef, onChoose, onFocus }: ApprovalChoiceRowProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={focused ? 0 : -1}
      aria-disabled={submitting || dimmed ? true : undefined}
      className={choiceRowClass(focused, submitting, dimmed)}
      onClick={onChoose}
      onFocus={onFocus}
    >
      {submitting ? <RowSpinner /> : <KeyChip index={index} />}
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className={cn("text-sm text-ink", (focused || submitting) && "font-medium")}>
          {submitting ? submittingLabel : choice.label}
        </span>
        {choice.description && <span className="text-xs text-muted">{choice.description}</span>}
      </span>
    </button>
  );
}

/** Props for {@link ApprovalNoteRow}. */
export interface ApprovalNoteRowProps {
  readonly index: number;
  readonly label: string;
  readonly focused: boolean;
  /** An answer is in flight. */
  readonly dimmed: boolean;
  readonly inputRef: (element: HTMLInputElement | null) => void;
  readonly onSubmit: (note: string) => void;
  readonly onFocus: () => void;
}

/** Numbered deny-with-a-note row. Enter denies and sends the note to the provider. */
export function ApprovalNoteRow({ index, label, focused, dimmed, inputRef, onSubmit, onFocus }: ApprovalNoteRowProps) {
  const [note, setNote] = useState("");
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const trimmed = note.trim();
    if (trimmed && !dimmed) onSubmit(trimmed);
  };
  return (
    <label className={cn(ROW_CLASS, "cursor-text focus-within:bg-hover", focused && "bg-hover", dimmed && "opacity-45")}>
      <KeyChip index={index} />
      <input
        ref={inputRef}
        type="text"
        tabIndex={focused ? 0 : -1}
        value={note}
        maxLength={4_000}
        readOnly={dimmed}
        placeholder={label}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
      />
    </label>
  );
}
