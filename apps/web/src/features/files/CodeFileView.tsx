import { useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileReadResult } from "@mcode/contracts";
import { Button } from "@/components/ui/button";
import type { TokenSpan } from "@/workers/shiki.worker";
import type { FileReadState } from "./useFilesData";
import { useCodeTokens } from "./useCodeTokens";

const LINE_HEIGHT = 20;
const OVERSCAN = 20;
const CHANGED_LINE_SHADOW = "var(--color-primary) 2px 0 0 inset";

/** Formats a byte count the way the Files states show it ("412 KB", "3.1 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Props for {@link CodeFileView}. */
export interface CodeFileViewProps {
  readonly path: string;
  readonly state: FileReadState;
  readonly onOpenInEditor: (line?: number) => void;
  readonly onCloseTab: () => void;
}

/** The Files body for one open file: code, or the state that explains why there is none. */
export function CodeFileView({ path, state, onOpenInEditor, onCloseTab }: CodeFileViewProps) {
  if (state.status === "loading") return <StateLine>Loading…</StateLine>;
  if (state.status === "missing") {
    return (
      <StateMessage text="This file no longer exists.">
        <Button variant="outline" size="compact" onClick={onCloseTab}>Close tab</Button>
      </StateMessage>
    );
  }
  if (state.status === "failed") return <StateMessage text={state.message} />;
  return <ReadResultView path={path} result={state.result} onOpenInEditor={onOpenInEditor} />;
}

function ReadResultView({
  path,
  result,
  onOpenInEditor,
}: {
  readonly path: string;
  readonly result: FileReadResult;
  readonly onOpenInEditor: (line?: number) => void;
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
      return <CodeLines path={path} content={result.content} changedLines={result.changedLines} />;
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

function changedLineSet(changedLines: readonly (readonly [number, number])[] | null): ReadonlySet<number> {
  const set = new Set<number>();
  for (const [start, end] of changedLines ?? []) {
    for (let line = start; line <= end; line += 1) set.add(line);
  }
  return set;
}

function CodeLines({
  path,
  content,
  changedLines,
}: {
  readonly path: string;
  readonly content: string;
  readonly changedLines: readonly (readonly [number, number])[] | null;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => content.replace(/\r\n?/g, "\n").split("\n"), [content]);
  const changed = useMemo(() => changedLineSet(changedLines), [changedLines]);
  const tokens = useCodeTokens(path, content);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: OVERSCAN,
    useFlushSync: false,
  });
  return (
    <div ref={viewportRef} data-testid="code-file-view" className="min-h-0 flex-1 overflow-auto bg-background py-3 font-mono text-code-small">
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
                <LineContent text={lines[item.index] ?? ""} tokens={tokens?.[item.index]} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
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
