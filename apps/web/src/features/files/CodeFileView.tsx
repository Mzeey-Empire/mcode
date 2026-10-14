import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DraftFileComment, FileReadResult } from "@mcode/contracts";
import {
  editDraftFileComment,
  setDraftFileCommentEditor,
  useFileCommentEditorAnchor,
  useNumberedFileComments,
  type FileCommentEditorAnchor,
} from "@/features/conversation/composer/draft/draft-file-comments";
import type { FileCommentTarget } from "@/features/conversation/composer/draft/draft-submission";
import { Button } from "@/components/ui/button";
import type { TokenSpan } from "@/workers/shiki.worker";
import type { FileReadState } from "./useFilesData";
import { useCodeTokens } from "./useCodeTokens";
import { FILE_COMMENT_CARD_CLASS, FILE_COMMENT_ROW_CLASS, FileCommentEditor } from "./FileCommentEditor";
import { useFilesTabsStore } from "./filesTabsStore";

const LINE_HEIGHT = 20;
const OVERSCAN = 20;
const COMMENT_ROW_ESTIMATE = 72;
/** The line-number column, `w-11`. Comment cards inset by the same amount. */
const GUTTER_PX = 44;
const CODE_END_PAD_PX = 16;
const CHANGED_LINE_SHADOW = "var(--color-primary) 2px 0 0 inset";

/** Formats a byte count the way the Files states show it ("412 KB", "3.1 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface CodeFileViewProps {
  readonly path: string;
  readonly state: FileReadState;
  readonly onOpenInEditor: (line?: number) => void;
  readonly onCloseTab: () => void;
  /** Thread whose draft receives line comments; null disables commenting. */
  readonly threadId: string | null;
  /** Files panel scope, for pending jumps. */
  readonly scopeId: string;
  /** Workspace that scopes mention suggestions in the comment editor. */
  readonly workspaceId?: string;
}

/** The Files body for one open file: code, or the state that explains why there is none. */
export function CodeFileView({ path, state, onOpenInEditor, onCloseTab, ...commentScope }: CodeFileViewProps) {
  if (state.status === "loading") return <StateLine>Loading…</StateLine>;
  if (state.status === "missing") {
    return (
      <StateMessage text="This file no longer exists.">
        <Button variant="outline" size="compact" onClick={onCloseTab}>Close tab</Button>
      </StateMessage>
    );
  }
  if (state.status === "failed") return <StateMessage text={state.message} />;
  return <ReadResultView path={path} result={state.result} onOpenInEditor={onOpenInEditor} commentScope={commentScope} />;
}

function ReadResultView({
  path,
  result,
  onOpenInEditor,
  commentScope,
}: {
  readonly path: string;
  readonly result: FileReadResult;
  readonly onOpenInEditor: (line?: number) => void;
  readonly commentScope: Pick<CodeFileViewProps, "threadId" | "scopeId" | "workspaceId">;
}) {
  const openButton = <Button variant="outline" size="compact" onClick={() => onOpenInEditor()}>Open in editor</Button>;
  switch (result.kind) {
    case "too-large":
      return <StateMessage text={`Too large to show · ${formatFileSize(result.size)}`}>{openButton}</StateMessage>;
    // Images render in S12P-06; until then they take the binary state so they never crash the view.
    case "image":
    case "binary":
      return <StateMessage text={`Binary file · ${formatFileSize(result.size)}`}>{openButton}</StateMessage>;
    case "text":
      if (result.content.length === 0) return <StateLine>Empty file</StateLine>;
      return <CodeLines path={path} content={result.content} changedLines={result.changedLines} {...commentScope} />;
  }
}

function StateLine({ children }: { readonly children: ReactNode }) {
  return <p className="px-4 py-3 font-mono text-code-small text-muted">{children}</p>;
}

function StateMessage({ text, children }: { readonly text: string; readonly children?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-3">
      <p className="text-body-small text-muted">{text}</p>
      {children}
    </div>
  );
}

/** Splits on any newline style; a final newline ends the last line rather than starting an empty one. */
export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function changedLineSet(changedLines: readonly (readonly [number, number])[] | null): ReadonlySet<number> {
  const set = new Set<number>();
  for (const [start, end] of changedLines ?? []) {
    for (let line = start; line <= end; line += 1) set.add(line);
  }
  return set;
}

/** One virtual row: a code line, a saved comment card under its line, or the open editor. */
type CodeRow =
  | { readonly kind: "line"; readonly index: number }
  | { readonly kind: "comment"; readonly comment: DraftFileComment }
  | { readonly kind: "editor"; readonly target: FileCommentTarget; readonly annotation?: DraftFileComment };

/**
 * Interleaves comment rows under their lines. The comment being edited renders
 * as the editor in its card's place, and a new comment's editor follows its line.
 */
function buildCodeRows(
  path: string,
  lines: readonly string[],
  comments: readonly DraftFileComment[],
  anchor: FileCommentEditorAnchor | undefined,
): CodeRow[] {
  const byLine = new Map<number, DraftFileComment[]>();
  for (const comment of comments) {
    if (comment.filePath !== path) continue;
    byLine.set(comment.line, [...(byLine.get(comment.line) ?? []), comment]);
  }
  const draft = anchor?.kind === "draft" && anchor.filePath === path ? anchor : null;
  const rows: CodeRow[] = [];
  lines.forEach((_, index) => {
    const line = index + 1;
    rows.push({ kind: "line", index });
    for (const comment of byLine.get(line) ?? []) {
      const editing = anchor?.kind === "edit" && anchor.annotationId === comment.id;
      // The target must hold only target fields: the save spreads it over the comment it writes.
      const target = { filePath: comment.filePath, line: comment.line, lineContent: comment.lineContent };
      rows.push(editing ? { kind: "editor", target, annotation: comment } : { kind: "comment", comment });
    }
    if (draft?.line === line) {
      rows.push({ kind: "editor", target: { filePath: path, line, lineContent: draft.lineContent } });
    }
  });
  return rows;
}

function rowKey(row: CodeRow | undefined, index: number): string {
  if (!row) return String(index);
  if (row.kind === "line") return `line:${row.index}`;
  if (row.kind === "comment") return `comment:${row.comment.id}`;
  return `editor:${row.annotation?.id ?? row.target.line}`;
}

/** Scrolls to a jump another surface asked for once this file's rows exist, then clears it. */
function usePendingJump(scopeId: string, path: string, rows: readonly CodeRow[], scrollToIndex: (index: number) => void) {
  const jump = useFilesTabsStore((store) => store.scopes[scopeId]?.pendingJump ?? null);
  useEffect(() => {
    if (!jump || jump.path !== path) return;
    const index = rows.findIndex((row) => row.kind === "line" && row.index === jump.line - 1);
    if (index >= 0) scrollToIndex(index);
    useFilesTabsStore.getState().clearJump(scopeId);
  }, [jump, path, rows, scopeId, scrollToIndex]);
}

function CodeLines({
  path,
  content,
  changedLines,
  threadId,
  workspaceId,
  scopeId,
}: {
  readonly path: string;
  readonly content: string;
  readonly changedLines: readonly (readonly [number, number])[] | null;
  readonly threadId: string | null;
  readonly workspaceId?: string;
  readonly scopeId: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => splitLines(content), [content]);
  const changed = useMemo(() => changedLineSet(changedLines), [changedLines]);
  const tokens = useCodeTokens(path, content);
  const comments = useNumberedFileComments(threadId ?? undefined);
  const anchor = useFileCommentEditorAnchor(threadId ?? undefined);
  const rows = useMemo(
    () => (threadId ? buildCodeRows(path, lines, comments, anchor) : buildCodeRows(path, lines, [], undefined)),
    [anchor, comments, lines, path, threadId],
  );
  // Rows are absolutely positioned, so nothing else gives the track the width of its longest line.
  const trackMinWidth = useMemo(
    () => `calc(${GUTTER_PX + CODE_END_PAD_PX}px + ${lines.reduce((widest, line) => Math.max(widest, line.length), 0)}ch)`,
    [lines],
  );
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    // Comment rows are measured once mounted; a code line is always one fixed row.
    estimateSize: (index) => (rows[index]?.kind === "line" || rows[index] === undefined ? LINE_HEIGHT : COMMENT_ROW_ESTIMATE),
    getItemKey: (index) => rowKey(rows[index], index),
    overscan: OVERSCAN,
    useFlushSync: false,
  });
  const scrollToIndex = useCallback((index: number) => virtualizer.scrollToIndex(index, { align: "center" }), [virtualizer]);
  usePendingJump(scopeId, path, rows, scrollToIndex);
  const openEditor = (index: number) => {
    if (!threadId) return;
    setDraftFileCommentEditor(threadId, {
      target: { filePath: path, line: index + 1, lineContent: lines[index] ?? "" },
      note: "",
      mentions: [],
    });
  };
  return (
    <div ref={viewportRef} data-testid="code-file-view" className="@container min-h-0 flex-1 overflow-auto bg-background py-3 font-mono text-code-small">
      <div className="relative min-w-full" style={{ height: virtualizer.getTotalSize(), minWidth: trackMinWidth }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          if (row.kind !== "line") {
            return (
              <div key={item.key} ref={virtualizer.measureElement} data-index={item.index} className="absolute inset-x-0" style={{ top: item.start }}>
                {/* Pinned to the viewport so a long line elsewhere in the file never stretches or scrolls the card away. */}
                <div className="sticky left-0 w-[100cqw]">
                  {threadId ? <CommentRow threadId={threadId} workspaceId={workspaceId} row={row} /> : null}
                </div>
              </div>
            );
          }
          const lineNumber = row.index + 1;
          return (
            <div
              key={item.key}
              data-line={lineNumber}
              data-changed={changed.has(lineNumber) || undefined}
              className="group absolute inset-x-0 flex whitespace-pre hover:bg-hover"
              style={{ top: item.start, height: LINE_HEIGHT, boxShadow: changed.has(lineNumber) ? CHANGED_LINE_SHADOW : undefined }}
            >
              <LineGutter lineNumber={lineNumber} commentable={threadId !== null} onComment={() => openEditor(row.index)} />
              <span className="pr-4 text-ink">
                <LineContent text={lines[row.index] ?? ""} tokens={tokens?.[row.index]} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CommentRow({
  threadId,
  workspaceId,
  row,
}: {
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly row: Exclude<CodeRow, { kind: "line" }>;
}) {
  if (row.kind === "editor") {
    return <FileCommentEditor threadId={threadId} workspaceId={workspaceId} target={row.target} annotation={row.annotation} />;
  }
  return (
    <div className={FILE_COMMENT_ROW_CLASS}>
      <button
        type="button"
        aria-label={`Edit comment on line ${row.comment.line}`}
        className={`${FILE_COMMENT_CARD_CLASS} block w-full whitespace-pre-wrap px-3 py-2 text-left`}
        onClick={() => editDraftFileComment(threadId, row.comment)}
      >
        {row.comment.note}
      </button>
    </div>
  );
}

function LineGutter({
  lineNumber,
  commentable,
  onComment,
}: {
  readonly lineNumber: number;
  readonly commentable: boolean;
  readonly onComment: () => void;
}) {
  if (!commentable) {
    return <span aria-hidden className="w-11 shrink-0 select-none pr-3.5 text-right text-muted">{lineNumber}</span>;
  }
  return (
    <span className="relative w-11 shrink-0 cursor-pointer select-none pr-3.5 text-right text-muted" onClick={onComment}>
      <span aria-hidden className="group-hover:invisible group-has-[:focus-visible]:invisible">{lineNumber}</span>
      {/* Absolute so showing it never shifts the columns; it takes the number's place so digits never sit under it. */}
      <button
        type="button"
        aria-label={`Comment on line ${lineNumber}`}
        className="absolute top-0 left-0.5 hidden size-5 items-center justify-center rounded-[5px] bg-ink text-background group-hover:flex focus-visible:flex"
      >
        <Plus size={12} aria-hidden />
      </button>
    </span>
  );
}

function LineContent({ text, tokens }: { readonly text: string; readonly tokens: TokenSpan[] | undefined }) {
  if (!tokens) return <>{text}</>;
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={{ color: token.color }}>{token.content}</span>
      ))}
    </>
  );
}
