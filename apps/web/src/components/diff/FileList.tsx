import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReviewFileChange } from "@mcode/contracts";
import { useDiffStore, type DiffSource } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { orderReviewFiles } from "@/lib/review-file-order";
import { ReviewDiffView } from "./ReviewDiffView";

const PIERRE_WORKER_POOL_SIZE = 3;

/** Snapshot paths arrive with platform separators; comparison paths may not. */
const normalizeJumpPath = (path: string) => path.replace(/\\/g, "/");

const pierrePoolOptions = {
  poolSize: PIERRE_WORKER_POOL_SIZE,
  workerFactory: () =>
    new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
      type: "module",
    }),
};

/** Props for FileList. */
interface FileListProps {
  files: ReviewFileChange[];
  source: DiffSource;
  id: string;
  /** Thread that owns these files, used to scope the inline diff cache. */
  threadId: string;
  /** When true every file entry starts expanded (used for the latest turn). */
  defaultFilesExpanded?: boolean;
  /** Extra identity for mutable comparisons whose ref names can stay stable while content changes. */
  cacheVersion?: string | number;
  /** Read Git patches with whitespace changes hidden, matching the comparison. */
  ignoreWhitespace?: boolean;
  /**
   * Identity of the view rendering this list (e.g. `turn:<messageId>`).
   * View-keyed jump requests are consumed only by the list whose key matches,
   * so a still-mounted outgoing view cannot swallow a request meant for the
   * incoming one.
   */
  jumpViewKey?: string;
}

/**
 * Renders the changed files through pierre's virtualized CodeView: one scroll
 * container, one item per file, with headers, collapsed context bands, and
 * inline comments. Its controls live in the Review header's row 2.
 */
export function FileList({
  files,
  source,
  id,
  threadId,
  defaultFilesExpanded = false,
  cacheVersion = 0,
  ignoreWhitespace = false,
  jumpViewKey,
}: FileListProps) {
  const [jumpTarget, setJumpTarget] = useState<{ path: string; token: number } | null>(null);
  const [highlightPath, setHighlightPath] = useState<string | null>(null);
  const jumpTokenRef = useRef(0);
  const highlightClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A consumed keyed jump can fire against a comparison that is about to be
  // swapped out (the view's operand changed but its replacement is still
  // loading); arm a one-shot re-jump keyed on the comparison id.
  const reJumpRef = useRef<{ path: string; id: string } | null>(null);
  const orderedFiles = useMemo(() => orderReviewFiles(files), [files]);

  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const renderMode = useDiffStore((s) => s.renderMode);
  const lineWrap = useDiffStore((s) => (activeThreadId ? s.getLineWrap(activeThreadId) : true));

  useEffect(() => {
    return () => {
      if (highlightClearRef.current) clearTimeout(highlightClearRef.current);
    };
  }, []);

  const jumpToFile = useCallback((path: string) => {
    const token = ++jumpTokenRef.current;
    setJumpTarget({ path, token });
    setHighlightPath(path);

    if (highlightClearRef.current) clearTimeout(highlightClearRef.current);
    highlightClearRef.current = setTimeout(() => {
      setHighlightPath((current) => (current === path ? null : current));
      highlightClearRef.current = null;
    }, 1500);
  }, []);

  const clearJumpTarget = useCallback((token: number) => {
    setJumpTarget((current) => (current?.token === token ? null : current));
  }, []);

  useEffect(() => {
    // A jump request can predate this list's mount (the requester opens a view,
    // the comparison loads, then this list mounts). Consume the pending request
    // on entry and on file-list changes, then subscribe for live requests.
    const consumeJumpRequest = (request: { scopeId: string; path: string; nonce: number; viewKey?: string } | null) => {
      if (!request || request.scopeId !== threadId) return;
      // A view-keyed request is owned by the view it was issued for; the
      // outgoing view's still-mounted list must not consume it.
      if (request.viewKey && request.viewKey !== jumpViewKey) return;
      const requested = normalizeJumpPath(request.path);
      const target = orderedFiles.find((f) => normalizeJumpPath(f.path) === requested);
      if (!target) return;
      useDiffStore.getState().clearReviewFileJump();
      // Only keyed requests arm the re-jump; an unkeyed jump is owned by no
      // view and must not resurface on an unrelated comparison swap.
      reJumpRef.current = request.viewKey
        ? { path: normalizeJumpPath(target.path), id }
        : null;
      jumpToFile(target.path);
    };
    const armed = reJumpRef.current;
    if (armed && armed.id !== id) {
      reJumpRef.current = null;
      const target = orderedFiles.find(
        (f) => normalizeJumpPath(f.path) === armed.path,
      );
      if (target) jumpToFile(target.path);
    }
    consumeJumpRequest(useDiffStore.getState().reviewFileJumpRequest);
    return useDiffStore.subscribe((state, prev) => {
      if (state.reviewFileJumpRequest === prev.reviewFileJumpRequest) return;
      consumeJumpRequest(state.reviewFileJumpRequest);
    });
  }, [id, jumpToFile, jumpViewKey, orderedFiles, threadId]);

  if (files.length === 0) {
    return (
      <p className="px-3 py-1 text-caption text-muted">No files changed</p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* jsdom and non-DOM environments have no Worker; pierre falls back to
          main-thread highlighting when no pool provider is present. */}
      {typeof Worker === "undefined" ? (
        <ReviewDiffView
          files={orderedFiles}
          source={source}
          id={id}
          threadId={threadId}
          cacheVersion={cacheVersion}
          ignoreWhitespace={ignoreWhitespace}
          defaultFilesExpanded={defaultFilesExpanded}
          jumpTarget={jumpTarget}
          onJumpSettled={clearJumpTarget}
          highlightPath={highlightPath}
          renderMode={renderMode}
          lineWrap={lineWrap}
        />
      ) : (
      <WorkerPoolContextProvider
        poolOptions={pierrePoolOptions}
        highlighterOptions={{}}
      >
        <ReviewDiffView
          files={orderedFiles}
          source={source}
          id={id}
          threadId={threadId}
          cacheVersion={cacheVersion}
          ignoreWhitespace={ignoreWhitespace}
          defaultFilesExpanded={defaultFilesExpanded}
          jumpTarget={jumpTarget}
          onJumpSettled={clearJumpTarget}
          highlightPath={highlightPath}
          renderMode={renderMode}
          lineWrap={lineWrap}
        />
      </WorkerPoolContextProvider>
      )}
    </div>
  );
}
