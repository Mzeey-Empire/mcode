import type { ReactNode } from "react";
import type { ApprovalSubject as ApprovalSubjectModel } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { ApprovalPatchPreview } from "./ApprovalPatchPreview";

type SubjectOf<K extends ApprovalSubjectModel["kind"]> = Extract<ApprovalSubjectModel, { kind: K }>;

function SubjectBlock({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-col gap-1.5 rounded-md bg-hover px-3 py-2">{children}</div>;
}

function FactsLine({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs text-muted">{children}</p>;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function commandFacts(subject: SubjectOf<"command">): string | undefined {
  const parts = [subject.cwd ? `in ${basename(subject.cwd)}` : undefined, ...(subject.facts ?? [])].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// Scope is never truncated: a long command wraps and the block scrolls, so the user always sees what they allow.
const SCOPE_TEXT_CLASS = "max-h-60 overflow-y-auto whitespace-pre-wrap break-all font-mono text-code-small";

function CommandSubject({ subject }: { readonly subject: SubjectOf<"command"> }) {
  const facts = commandFacts(subject);
  return (
    <>
      <SubjectBlock>
        <div className="flex gap-2">
          <span className="shrink-0 font-mono text-code-small text-muted">$</span>
          <code className={`min-w-0 text-ink ${SCOPE_TEXT_CLASS}`}>{subject.command}</code>
        </div>
      </SubjectBlock>
      {facts && <FactsLine>{facts}</FactsLine>}
    </>
  );
}

function splitPath(path: string): { name: string; folder: string } {
  const name = basename(path);
  return { name, folder: path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]$/, "") };
}

// One file shows in the dock; the rest are counted here and listed in Open diff.
function FileEditSubject({ subject }: { readonly subject: SubjectOf<"file_edit"> }) {
  const [file] = subject.files;
  if (!file) return null;
  const { name, folder } = splitPath(file.path);
  const otherFiles = subject.files.length - 1;
  return (
    <SubjectBlock>
      <div className="flex h-5 items-center gap-2 font-code">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-code-small text-fade">
          <span className="text-ink">{name}</span>
          {folder && <span className="text-muted">{folder}</span>}
        </span>
        {otherFiles > 0 && <span className="shrink-0 text-xs text-muted">+{otherFiles} {otherFiles === 1 ? "file" : "files"}</span>}
        <span className="shrink-0 text-xs text-success">+{file.additions}</span>
        <span className="shrink-0 text-xs text-error">−{file.deletions}</span>
      </div>
      <ApprovalPatchPreview files={subject.files} />
    </SubjectBlock>
  );
}

function FetchSubject({ subject }: { readonly subject: SubjectOf<"fetch"> }) {
  return <SubjectBlock><code className={`text-ink ${SCOPE_TEXT_CLASS}`}>{subject.url}</code></SubjectBlock>;
}

function ToolSubject({ subject }: { readonly subject: SubjectOf<"tool"> }) {
  return (
    <SubjectBlock>
      <code className="font-mono text-code-small text-ink">{subject.toolName}</code>
      {subject.preview && <code className={`text-muted ${SCOPE_TEXT_CLASS}`}>{subject.preview}</code>}
    </SubjectBlock>
  );
}

function ThreadOperationSubject({ subject }: { readonly subject: SubjectOf<"thread_operation"> }) {
  const storedTitle = useWorkspaceStore((state) => state.threads.find((thread) => thread.id === subject.targetThreadId)?.title);
  const target = subject.targetTitle ?? storedTitle;
  if (subject.operation === "thread_create_batch") return null;
  return (
    <SubjectBlock>
      <p className="text-xs text-muted text-fade">To · {target || "another thread"}</p>
      {subject.message && <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm text-ink">{subject.message}</p>}
    </SubjectBlock>
  );
}

/** What the request would do, in full. Questions render in the transcript, not here. */
export function ApprovalSubject({ subject }: { readonly subject: ApprovalSubjectModel }) {
  switch (subject.kind) {
    case "command": return <CommandSubject subject={subject} />;
    case "file_edit": return <FileEditSubject subject={subject} />;
    case "fetch": return <FetchSubject subject={subject} />;
    case "tool": return <ToolSubject subject={subject} />;
    case "thread_operation": return <ThreadOperationSubject subject={subject} />;
    case "question": return null;
  }
}
