import type { KeyboardEvent, Ref } from "react";
import { cn } from "@/lib/utils";
import { KeyChip, ROW_CLASS } from "./ApprovalChoiceRow";

/** Props for {@link ApprovalNoteRow}. */
export interface ApprovalNoteRowProps {
  readonly index: number;
  readonly placeholder: string;
  readonly value: string;
  readonly focused: boolean;
  readonly inputRef: Ref<HTMLTextAreaElement>;
  readonly onChange: (value: string) => void;
  /** Called with the trimmed note; never with an empty one. */
  readonly onSubmit: (note: string) => void;
  /** Esc hands focus back to the choice rows. */
  readonly onLeave: () => void;
  readonly onFocus: () => void;
}

/**
 * Deny with a note. Its keys stay inside the input, so typing a digit or a bracket writes
 * text instead of answering or paging the dock.
 */
export function ApprovalNoteRow({ index, placeholder, value, focused, inputRef, onChange, onSubmit, onLeave, onFocus }: ApprovalNoteRowProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onLeave();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const note = value.trim();
    if (note) onSubmit(note);
  };

  return (
    <div className={cn(ROW_CLASS, focused && "bg-hover")}>
      <KeyChip index={index} />
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className="field-sizing-content max-h-32 min-w-0 flex-1 resize-none bg-transparent text-sm text-ink outline-none placeholder:text-muted"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={onFocus}
      />
    </div>
  );
}
