import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileReadResult } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TokenSpan } from "@/workers/shiki.worker";
import type { FileReadState } from "./useFilesData";
import { useCodeTokens } from "./useCodeTokens";
import { splitPieces, type FindMatch, type FindResult, type LineHighlight, type LinePiece } from "./find-in-file";
import type { FindHighlight } from "./useFindInFile";

const LINE_HEIGHT = 20;
const OVERSCAN = 20;
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
  /** Find matches to paint in a text file, or null while the find bar is closed. */
  readonly find?: FindHighlight | null;
}

/** The Files body for one open file: code, or the state that explains why there is none. */
export function CodeFileView({ path, state, onOpenInEditor, onCloseTab, find = null }: CodeFileViewProps) {
  if (state.status === "loading") return <StateLine>Loading…</StateLine>;
  if (state.status === "missing") {
    return (
      <StateMessage text="This file no longer exists.">
        <Button variant="outline" size="compact" onClick={onCloseTab}>Close tab</Button>
      </StateMessage>
    );
  }
  if (state.status === "failed") return <StateMessage text={state.message} />;
  return <ReadResultView path={path} result={state.result} onOpenInEditor={onOpenInEditor} find={find} />;
}

function ReadResultView({
  path,
  result,
  onOpenInEditor,
  find,
}: {
  readonly path: string;
  readonly result: FileReadResult;
  readonly onOpenInEditor: (line?: number) => void;
  readonly find: FindHighlight | null;
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
      return <CodeLines path={path} content={result.content} changedLines={result.changedLines} find={find} />;
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

interface IndexedMatch extends FindMatch {
  readonly index: number;
}

function matchesByLine(result: FindResult | undefined): ReadonlyMap<number, readonly IndexedMatch[]> {
  const byLine = new Map<number, IndexedMatch[]>();
  if (result?.status !== "ready") return byLine;
  result.matches.forEach((match, index) => {
    const onLine = byLine.get(match.line);
    if (onLine) onLine.push({ ...match, index });
    else byLine.set(match.line, [{ ...match, index }]);
  });
  return byLine;
}

function currentMatch(find: FindHighlight | null): FindMatch | null {
  return find?.result.status === "ready" ? (find.result.matches[find.index] ?? null) : null;
}

function CodeLines({
  path,
  content,
  changedLines,
  find,
}: {
  readonly path: string;
  readonly content: string;
  readonly changedLines: readonly (readonly [number, number])[] | null;
  readonly find: FindHighlight | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => splitLines(content), [content]);
  const changed = useMemo(() => changedLineSet(changedLines), [changedLines]);
  const tokens = useCodeTokens(path, content);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
    useFlushSync: false,
  });
  const foundByLine = useMemo(() => matchesByLine(find?.result), [find?.result]);
  const currentIndex = find?.index ?? -1;
  const currentLine = currentMatch(find)?.line ?? null;
  const navigation = find?.navigation;
  const revealedNavigation = useRef<number | undefined>(undefined);
  const revealCurrent = (element: HTMLElement | null) => {
    if (!element || revealedNavigation.current === navigation) return;
    revealedNavigation.current = navigation;
    element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  useEffect(() => {
    if (currentLine !== null) virtualizer.scrollToIndex(currentLine, { align: "auto" });
  }, [currentLine, navigation, virtualizer]);

  return (
    <div
      ref={viewportRef}
      data-testid="code-file-view"
      data-code-viewport=""
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto bg-background py-3 font-mono text-code-small outline-none"
    >
      <div className="relative min-w-max" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const lineNumber = item.index + 1;
          return (
            <div
              key={item.key}
              data-line={lineNumber}
              data-changed={changed.has(lineNumber) || undefined}
              className="absolute inset-x-0 flex whitespace-pre"
              style={{ top: item.start, height: LINE_HEIGHT, boxShadow: changed.has(lineNumber) ? CHANGED_LINE_SHADOW : undefined }}
            >
              <span aria-hidden className="w-11 shrink-0 select-none pr-3.5 text-right text-muted">{lineNumber}</span>
              <span className="pr-4 text-ink">
                <LineContent
                  text={lines[item.index] ?? ""}
                  tokens={tokens?.[item.index]}
                  found={foundByLine.get(item.index)}
                  currentIndex={currentIndex}
                  revealCurrent={revealCurrent}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LineContent({
  text,
  tokens,
  found,
  currentIndex,
  revealCurrent,
}: {
  readonly text: string;
  readonly tokens: TokenSpan[] | undefined;
  readonly found: readonly IndexedMatch[] | undefined;
  readonly currentIndex: number;
  readonly revealCurrent: (element: HTMLElement | null) => void;
}) {
  if (!found && !tokens) return <>{text}</>;
  const pieces: readonly LinePiece[] = tokens ?? [{ content: text }];
  if (!found) {
    return (
      <>
        {pieces.map((piece, index) => (
          <span key={index} style={{ color: piece.color }}>{piece.content}</span>
        ))}
      </>
    );
  }
  const highlights: LineHighlight[] = found.map((match) => ({ start: match.start, end: match.end, current: match.index === currentIndex }));
  return (
    <>
      {splitPieces(pieces, highlights).map((piece, index) =>
        piece.match ? (
          <mark
            key={index}
            data-find-match={piece.match}
            ref={piece.match === "current" ? revealCurrent : undefined}
            className={cn("rounded-[3px] text-inherit", piece.match === "current" ? "bg-primary text-primary-ink" : "bg-primary/30")}
          >
            {piece.content}
          </mark>
        ) : (
          <span key={index} style={{ color: piece.color }}>{piece.content}</span>
        ),
      )}
    </>
  );
}
