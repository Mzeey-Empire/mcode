import { lazy, Suspense, useCallback, useRef, type MouseEvent } from "react";
import { useToastStore } from "@/stores/toastStore";
import { CodeLines } from "./CodeFileView";
import type { FileViewMode } from "./filesTabsStore";
import { resolveMarkdownHref } from "./markdown-links";
import type { FindHighlight } from "./useFindInFile";

const PreviewMarkdown = lazy(() => import("@/components/diff/DiffPreviewMarkdown"));

const NO_ADDED_LINES: ReadonlySet<number> = new Set();

/** Props for {@link MarkdownFileView}. */
export interface MarkdownFileViewProps {
  readonly path: string;
  readonly content: string;
  readonly mode: FileViewMode;
  readonly knownPaths: ReadonlySet<string>;
  /** When the project list is truncated (or not loaded), a path missing from it may still exist. */
  readonly pathsTruncated: boolean;
  readonly onOpenFile: (path: string) => void;
  /** Thread whose draft receives line comments made in the Source view; null disables commenting. */
  readonly threadId: string | null;
  readonly workspaceId?: string;
  /** Files panel scope, for pending jumps. */
  readonly scopeId: string;
  /** Find matches to paint in the Source view; rendered markdown has no lines to highlight. */
  readonly find?: FindHighlight | null;
}

function openExternal(url: string): void {
  if (window.desktopBridge?.openExternalUrl) {
    void window.desktopBridge.openExternalUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function scrollToHeading(container: HTMLElement | null, id: string): void {
  const target = Array.from(container?.querySelectorAll<HTMLElement>("[id]") ?? []).find((element) => element.id === id);
  target?.scrollIntoView({ block: "start" });
}

function showFailure(title: string): void {
  useToastStore.getState().show({ kind: "failed", title });
}

/** A markdown tab: rendered with working links, or its highlighted source. */
export function MarkdownFileView({
  path,
  content,
  mode,
  knownPaths,
  pathsTruncated,
  onOpenFile,
  threadId,
  workspaceId,
  scopeId,
  find = null,
}: MarkdownFileViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onLinkClick = useCallback(
    (href: string, event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const target = resolveMarkdownHref(path, href);
      switch (target.kind) {
        case "file":
          if (pathsTruncated || knownPaths.has(target.path)) onOpenFile(target.path);
          else showFailure(`No file at ${target.path}`);
          return;
        case "anchor":
          scrollToHeading(containerRef.current, target.id);
          return;
        case "external":
          openExternal(target.url);
          return;
        case "outside-root":
          showFailure("Link leaves the project");
          return;
        case "ignored":
          return;
      }
    },
    [path, knownPaths, pathsTruncated, onOpenFile],
  );

  if (mode === "source") {
    return <CodeLines path={path} content={content} changedLines={null} threadId={threadId} workspaceId={workspaceId} scopeId={scopeId} find={find} />;
  }
  return (
    <div ref={containerRef} data-testid="markdown-file-view" className="min-h-0 flex-1 overflow-auto bg-background px-6 py-4 text-body text-ink">
      <Suspense fallback={<p className="font-mono text-code-small text-muted">Loading…</p>}>
        <PreviewMarkdown content={content} addedLines={NO_ADDED_LINES} onLinkClick={onLinkClick} />
      </Suspense>
    </div>
  );
}
