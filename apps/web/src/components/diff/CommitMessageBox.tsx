import { RefreshCw } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CommitDraft, MessageGeneration } from "@/hooks/useCommitSheet";

/** Props for {@link CommitMessageBox}. */
export interface CommitMessageBoxProps {
  readonly draft: CommitDraft;
  readonly onChange: (draft: CommitDraft) => void;
  readonly generation: MessageGeneration;
  readonly hasSelection: boolean;
  /** True while a commit is in flight. */
  readonly locked: boolean;
  readonly onRegenerate: () => void;
}

function subjectPlaceholder(generation: MessageGeneration, hasSelection: boolean): string {
  if (generation.kind === "writing") return "Writing a message…";
  return hasSelection ? "Commit message" : "Select files to commit";
}

function attribution(generation: MessageGeneration): { text: string; failed: boolean } | null {
  if (generation.kind === "written") return { text: `Written by ${generation.modelName}`, failed: false };
  if (generation.kind === "failed") return { text: "Couldn't write a message", failed: true };
  return null;
}

/**
 * Subject and body fields the utility model fills in. They are read-only while it
 * writes; Regenerate replaces whatever is there, edits included.
 */
export function CommitMessageBox({ draft, onChange, generation, hasSelection, locked, onRegenerate }: CommitMessageBoxProps) {
  const writing = generation.kind === "writing";
  const note = attribution(generation);
  return (
    <div className="flex flex-col gap-1 rounded-composer border border-border bg-field p-3">
      <Input
        aria-label="Commit subject"
        value={draft.subject}
        readOnly={writing || locked}
        placeholder={subjectPlaceholder(generation, hasSelection)}
        onChange={(event) => onChange({ ...draft, subject: event.target.value })}
        className="h-auto border-0 bg-transparent p-0 font-semibold shadow-none"
      />
      <Textarea
        aria-label="Commit body"
        value={draft.body}
        readOnly={writing || locked}
        rows={2}
        onChange={(event) => onChange({ ...draft, body: event.target.value })}
        className="min-h-0 resize-none border-0 bg-transparent p-0 text-muted shadow-none"
      />
      <div className="flex h-8 items-center justify-between gap-2">
        <span className={note?.failed ? "text-caption text-error" : "text-caption text-muted"}>{note?.text}</span>
        <IconButton
          shape="round"
          size="inline"
          variant="ghost"
          aria-label="Regenerate message"
          disabled={writing || locked || !hasSelection}
          onClick={onRegenerate}
        >
          <RefreshCw />
        </IconButton>
      </div>
    </div>
  );
}
