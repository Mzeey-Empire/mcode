import { useCallback, useEffect, useRef, useState } from "react";
import { WS_CHANNELS } from "@mcode/contracts/ws/channels";
import { type FileChangedLines, type FileReadResult, type WorkspaceFileChanges, type WorkspaceFileList } from "@mcode/contracts/models/workspace-file";
import { getTransport, pushEmitter } from "@/transport";
import { refreshWorkspaceFiles, useWorkspaceFileRefresh } from "@/features/projects/files/useWorkspaceFileRefresh";
import { useConnectionStore } from "@/stores/connectionStore";

/** Message the server's `file.read` rejects with when the path is gone. */
export const FILE_NOT_FOUND_MESSAGE = "This file no longer exists.";

/** Debounce for `turn.diffChanged` bursts while an agent writes many files. */
export const DIFF_CHANGED_REFRESH_DEBOUNCE_MS = 500;

export type FileReadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: FileReadResult }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly message: string };

const LOADING: FileReadState = { status: "loading" };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFailure(error: unknown): FileReadState {
  const message = errorMessage(error);
  return message.includes(FILE_NOT_FOUND_MESSAGE) ? { status: "missing" } : { status: "failed", message };
}

/** Workspace scope the Files tool reads from: the workspace root or a thread worktree. */
export interface FilesScope {
  readonly workspaceId: string;
  readonly threadId: string | null;
}

export interface FilesData {
  readonly list: WorkspaceFileList | null;
  readonly listError: string | null;
  readonly changes: WorkspaceFileChanges | null;
  readonly reads: Readonly<Record<string, FileReadState>>;
  /** Changed-line bars per open path. A path is absent until git reports ranges for it, and keeps the last answer while a refresh is pending or fails. */
  readonly changedLines: Readonly<Record<string, FileChangedLines>>;
}

// The transport rejects requests still in flight when the socket drops, so the loaders wait for
// a connection and run again after a reconnect instead of keeping that rejection on screen.
function useFileList(scope: FilesScope, revision: number, connected: boolean) {
  const [state, setState] = useState<{ list: WorkspaceFileList | null; error: string | null }>({ list: null, error: null });
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    getTransport()
      .listWorkspaceFiles(scope.workspaceId, scope.threadId ?? undefined)
      .then(
        (list) => !cancelled && setState({ list, error: null }),
        (error: unknown) => !cancelled && setState((current) => ({ list: current.list, error: errorMessage(error) })),
      );
    return () => {
      cancelled = true;
    };
  }, [scope.workspaceId, scope.threadId, revision, connected]);
  return state;
}

function useFileChanges(scope: FilesScope, revision: number, connected: boolean): WorkspaceFileChanges | null {
  const [changes, setChanges] = useState<WorkspaceFileChanges | null>(null);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    getTransport()
      .getWorkspaceFileChanges(scope.workspaceId, scope.threadId ?? undefined)
      .then(
        (next) => !cancelled && setChanges(next),
        // Marks are decoration; a failed status query leaves the last marks rather than blanking the tree.
        (error: unknown) => console.error("[files] Failed to load file changes", error),
      );
    return () => {
      cancelled = true;
    };
  }, [scope.workspaceId, scope.threadId, revision, connected]);
  return changes;
}

function omitPaths<T>(record: Readonly<Record<string, T>>, paths: readonly string[]): Readonly<Record<string, T>> {
  if (!paths.some((path) => path in record)) return record;
  const next = { ...record };
  for (const path of paths) delete next[path];
  return next;
}

/** Absent and null both mean "no bars", so an unchanged answer must not cost the open file a re-render. */
function sameChangedLines(previous: FileChangedLines | undefined, next: FileChangedLines): boolean {
  if (!previous || !next) return !previous && !next;
  return previous.length === next.length && previous.every(([start, end], index) => start === next[index]?.[0] && end === next[index]?.[1]);
}

function useFileReads(scope: FilesScope, openPaths: readonly string[]) {
  // FilesTool is keyed by scope, so reads never carry over from another checkout.
  const [reads, setReads] = useState<Readonly<Record<string, FileReadState>>>({});
  const [changedLines, setChangedLines] = useState<Readonly<Record<string, FileChangedLines>>>({});
  const requested = useRef(new Set<string>());

  const read = useCallback(
    (path: string) => {
      requested.current.add(path);
      const transport = getTransport();
      const threadId = scope.threadId ?? undefined;
      transport
        .readFileContent(scope.workspaceId, path, threadId)
        .then(
          (result): FileReadState => ({ status: "ready", result }),
          readFailure,
        )
        .then((next) => {
          if (requested.current.has(path)) setReads((current) => ({ ...current, [path]: next }));
        });
      // Changed lines cost a git process, so they arrive on their own and never hold the text back.
      transport
        .getFileChangedLines(scope.workspaceId, path, threadId)
        .then(
          (lines) => {
            if (!requested.current.has(path)) return;
            setChangedLines((current) => (sameChangedLines(current[path], lines) ? current : { ...current, [path]: lines }));
          },
          // The bars are decoration; a failed diff keeps the last bars rather than blanking the margin.
          (error: unknown) => console.error("[files] Failed to load changed lines", error),
        );
    },
    [scope.workspaceId, scope.threadId],
  );

  useEffect(() => {
    for (const path of openPaths) if (!requested.current.has(path)) read(path);
    const closed = [...requested.current].filter((path) => !openPaths.includes(path));
    for (const path of closed) requested.current.delete(path);
    if (closed.length > 0) setChangedLines((current) => omitPaths(current, closed));
  }, [openPaths, read]);

  return { reads, changedLines, read };
}

function useFilesChanged(scope: FilesScope, onChanged: (paths: readonly string[] | "all") => void): void {
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(
    () =>
      pushEmitter.on("files.changed", (data) => {
        const parsed = WS_CHANNELS["files.changed"].safeParse(data);
        if (!parsed.success) return;
        const event = parsed.data;
        if (event.workspaceId !== scope.workspaceId || (event.threadId ?? null) !== scope.threadId) return;
        onChangedRef.current(event.wholeWorkspace || !event.changedPaths ? "all" : event.changedPaths);
      }),
    [scope.workspaceId, scope.threadId],
  );
}

function useDiffChangedRefresh(scope: FilesScope): void {
  useEffect(() => {
    if (!scope.threadId) return;
    const threadId = scope.threadId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = pushEmitter.on("turn.diffChanged", (data) => {
      const parsed = WS_CHANNELS["turn.diffChanged"].safeParse(data);
      if (!parsed.success || parsed.data.threadId !== threadId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refreshWorkspaceFiles(scope.workspaceId, threadId), DIFF_CHANGED_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [scope.workspaceId, scope.threadId]);
}

/**
 * Loads everything the Files tool shows for a scope and keeps it fresh: the
 * server reports edits through `files.changed`, which refetches marks and
 * re-reads the open files it names (or all of them for whole-workspace changes).
 */
export function useFilesData(scope: FilesScope, openPaths: readonly string[]): FilesData {
  const [revision, setRevision] = useState(0);
  useWorkspaceFileRefresh(scope.workspaceId, scope.threadId);
  useDiffChangedRefresh(scope);
  const connected = useConnectionStore((state) => state.status === "connected");
  const { list, error } = useFileList(scope, revision, connected);
  const changes = useFileChanges(scope, revision, connected);
  const { reads, changedLines, read } = useFileReads(scope, openPaths);
  useFilesChanged(scope, (paths) => {
    setRevision((current) => current + 1);
    for (const path of openPaths) if (paths === "all" || paths.includes(path)) read(path);
  });
  return { list, listError: error, changes, reads: withLoading(reads, openPaths), changedLines };
}

function withLoading(
  reads: Readonly<Record<string, FileReadState>>,
  openPaths: readonly string[],
): Readonly<Record<string, FileReadState>> {
  if (openPaths.every((path) => path in reads)) return reads;
  const next: Record<string, FileReadState> = { ...reads };
  for (const path of openPaths) next[path] ??= LOADING;
  return next;
}
