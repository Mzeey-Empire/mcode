import { useState, useEffect, useCallback, useMemo, useReducer } from "react";
import { ChevronRight, Folder } from "lucide-react";
import type { FilesystemBrowseResult, WorkspaceCreateErrorCode } from "@mcode/contracts";
import { CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { useCommandPaletteStore } from "@/stores/commandPaletteStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { getTransport } from "@/transport";
import { isMac, isWindows } from "@/lib/platform";
import {
  splitBrowseQuery,
  filterBrowseEntries,
  getPaletteMode,
} from "../CommandPalette.logic";
import { PaletteFooterHints, type PaletteHint } from "../PaletteFooterHints";

type BrowseResult = FilesystemBrowseResult;

const BROWSE_HINTS: readonly PaletteHint[] = [
  { keys: ["↑", "↓"], label: "Navigate" },
  { keys: ["Enter"], label: "Open" },
  { keys: ["Alt", "↑"], label: "Parent" },
  { keys: ["Esc"], label: "Close" },
];

const REGISTRATION_ERROR_COPY: Record<WorkspaceCreateErrorCode, string> = {
  path_not_absolute: "Type the full path to the folder.",
  path_not_found: "This folder doesn't exist.",
  not_a_directory: "That's a file, not a folder.",
  too_broad: "Pick a project folder, not your home folder or a drive.",
  permission_denied: "Mcode can't read this folder.",
};

// The workspace store keeps the raw failure; transport and server messages are not user copy.
const UNEXPECTED_ADD_ERROR_COPY = "Mcode couldn't add this folder. Try again.";

const FILE_MANAGER_NAME = isWindows ? "File Explorer" : isMac ? "Finder" : "Files";

type BrowseDirectoryState =
  | { readonly requestKey: string; readonly result: BrowseResult; readonly error: null }
  | { readonly requestKey: string; readonly result: null; readonly error: string };

type BrowseDirectoryAction =
  | { readonly type: "loaded"; readonly requestKey: string; readonly result: BrowseResult }
  | { readonly type: "failed"; readonly requestKey: string };

function browseDirectoryReducer(
  _state: BrowseDirectoryState | null,
  action: BrowseDirectoryAction,
): BrowseDirectoryState {
  if (action.type === "loaded") {
    return { requestKey: action.requestKey, result: action.result, error: null };
  }
  return { requestKey: action.requestKey, result: null, error: "Could not browse this path." };
}

/**
 * Filesystem browser rendered inside the unified palette when the input
 * query is a path (~/, /foo, ./, ../, C:\…) or the bare `/` drives trigger.
 *
 * Behavior:
 * - The query is split into a directory portion and a leaf filter via
 *   `splitBrowseQuery`. The directory is fetched server-side; the leaf is a
 *   client-side substring filter against the returned entries.
 * - `Enter` on a highlighted folder appends its name + a trailing `/` to the
 *   query, descending into it.
 * - `Cmd/Ctrl+Enter` adds an exact, explicitly chosen directory as a project, unless it is home
 *   or a filesystem root.
 * - On desktop, the footer opens the native folder dialog and adds the chosen folder.
 */
export function BrowseView() {
  const query = useCommandPaletteStore((state) => state.query);
  const setQuery = useCommandPaletteStore((state) => state.setQuery);
  const setPendingConfirm = useCommandPaletteStore((state) => state.setPendingConfirm);
  const setPendingBack = useCommandPaletteStore((state) => state.setPendingBack);
  const close = useCommandPaletteStore((state) => state.close);
  const createWorkspace = useWorkspaceStore((state) => state.createWorkspace);
  const beginNewThread = useWorkspaceStore((state) => state.beginNewThread);

  const isDrivesMode = getPaletteMode(query) === "drives";
  const { directoryPath, leafFilter } = getBrowseQueryParts(query, isDrivesMode);
  const [browseAttempt, setBrowseAttempt] = useState(0);
  const { result, loading, error } = useBrowseDirectory(directoryPath, browseAttempt);
  const { addError, canAdd, handleAdd, handlePickFolder } = useBrowseAddAction({
    query,
    leafFilter,
    isDrivesMode,
    result,
    loading,
    error,
    createWorkspace,
    beginNewThread,
    close,
  });
  const { handleSelect, handleAscend } = useBrowseNavigation({
    directoryPath,
    isDrivesMode,
    result,
    setQuery,
  });
  const filteredEntries = useMemo(
    () => getFilteredEntries(result, leafFilter),
    [result, leafFilter],
  );
  const canAscend = Boolean(!isDrivesMode && leafFilter === "" && result?.parent);

  useRegisteredBrowseActions({
    canAddCurrentDirectory: canAdd,
    handleAdd,
    canAscend,
    handleAscend,
    setPendingConfirm,
    setPendingBack,
  });

  return (
    <>
      <BrowseList
        loading={loading}
        error={error}
        result={result}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        filteredEntries={filteredEntries}
        onSelect={handleSelect}
      />
      <BrowseError error={error} onRetry={() => setBrowseAttempt((attempt) => attempt + 1)} />
      <BrowseAddError addError={addError} />
      <PaletteFooterHints
        hints={BROWSE_HINTS}
        trailing={window.desktopBridge ? <OpenInFileManager onClick={handlePickFolder} /> : null}
      />
    </>
  );
}

function getBrowseQueryParts(query: string, isDrivesMode: boolean) {
  if (isDrivesMode) return { directoryPath: "/", leafFilter: "" };
  return splitBrowseQuery(query);
}

function useBrowseDirectory(directoryPath: string, browseAttempt: number) {
  const requestKey = `${directoryPath}\u0000${browseAttempt}`;
  const [state, dispatch] = useReducer(browseDirectoryReducer, null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getTransport().filesystemBrowse(directoryPath);
        if (!cancelled) dispatch({ type: "loaded", requestKey, result: data });
      } catch {
        if (!cancelled) dispatch({ type: "failed", requestKey });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directoryPath, requestKey]);

  if (!state || state.requestKey !== requestKey) {
    return { result: null, loading: true, error: null };
  }
  return { result: state.result, loading: false, error: state.error };
}

function getFilteredEntries(result: BrowseResult | null, leafFilter: string) {
  if (!result) return [];
  return filterBrowseEntries(result.entries, leafFilter);
}

function canAddCurrentDirectory({
  leafFilter,
  isDrivesMode,
  result,
  loading,
  error,
  isAdding,
}: {
  leafFilter: string;
  isDrivesMode: boolean;
  result: BrowseResult | null;
  loading: boolean;
  error: string | null;
  isAdding: boolean;
}): boolean {
  return Boolean(
    !isDrivesMode &&
      !loading &&
      !error &&
      !isAdding &&
      leafFilter === "" &&
      isAddableFolder(result),
  );
}

function isAddableFolder(result: BrowseResult | null): boolean {
  return Boolean(result?.isExactDirectory && !result.isTooBroad);
}

function useBrowseAddAction({
  query,
  leafFilter,
  isDrivesMode,
  result,
  loading,
  error,
  createWorkspace,
  beginNewThread,
  close,
}: {
  query: string;
  leafFilter: string;
  isDrivesMode: boolean;
  result: BrowseResult | null;
  loading: boolean;
  error: string | null;
  createWorkspace: ReturnType<typeof useWorkspaceStore.getState>["createWorkspace"];
  beginNewThread: (workspaceId?: string | null) => void;
  close: () => void;
}) {
  const [addErrorState, setAddErrorState] = useState<{
    readonly query: string;
    readonly message: string;
    readonly rejectedPath: string | null;
  } | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const currentError = addErrorState?.query === query ? addErrorState : null;
  const addError = currentError?.message ?? null;
  // The listing that made this folder addable is stale once the server rejects it; editing the path re-checks it.
  const isRejected = currentError !== null && currentError.rejectedPath === result?.path;
  const isCurrentDirectoryAddable = !isRejected && canAddCurrentDirectory({
    leafFilter,
    isDrivesMode,
    result,
    loading,
    error,
    isAdding,
  });

  // A reused registration opens the existing project the same way a new one does.
  const addFolder = useCallback(async (path: string) => {
    setAddErrorState(null);
    setIsAdding(true);
    try {
      const created = await createWorkspace(undefined, path);
      if (!created.ok) {
        setAddErrorState({ query, message: REGISTRATION_ERROR_COPY[created.error.code], rejectedPath: path });
        return;
      }
      beginNewThread(created.workspace.id);
      close();
    } catch {
      setAddErrorState({ query, message: UNEXPECTED_ADD_ERROR_COPY, rejectedPath: null });
    } finally {
      setIsAdding(false);
    }
  }, [beginNewThread, close, createWorkspace, query]);

  const handleAdd = useCallback(async () => {
    if (isCurrentDirectoryAddable && result) await addFolder(result.path);
  }, [addFolder, isCurrentDirectoryAddable, result]);

  const handlePickFolder = useCallback(async () => {
    const path = await window.desktopBridge?.showOpenDialog({ title: "Add a project folder" });
    if (path) await addFolder(path);
  }, [addFolder]);

  return { addError, canAdd: isCurrentDirectoryAddable, handleAdd, handlePickFolder };
}

function useBrowseNavigation({
  directoryPath,
  isDrivesMode,
  result,
  setQuery,
}: {
  directoryPath: string;
  isDrivesMode: boolean;
  result: BrowseResult | null;
  setQuery: (query: string) => void;
}) {
  const handleSelect = useCallback(
    (entryName: string) => setQuery(getSelectedDirectoryPath(entryName, directoryPath, isDrivesMode)),
    [directoryPath, isDrivesMode, setQuery],
  );
  const handleAscend = useCallback(() => {
    if (result?.parent) setQuery(getParentDirectoryPath(result.parent));
  }, [result, setQuery]);

  return { handleSelect, handleAscend };
}

function getSelectedDirectoryPath(
  entryName: string,
  directoryPath: string,
  isDrivesMode: boolean,
): string {
  if (isDrivesMode) return /^[A-Za-z]:$/.test(entryName) ? `${entryName}\\` : entryName;
  const separator = directoryPath.includes("\\") && !directoryPath.includes("/") ? "\\" : "/";
  return directoryPath + entryName + separator;
}

function getParentDirectoryPath(parent: string): string {
  const separator = /^[A-Za-z]:/.test(parent) ? "\\" : "/";
  return parent.endsWith(separator) ? parent : parent + separator;
}

function useRegisteredBrowseActions({
  canAddCurrentDirectory,
  handleAdd,
  canAscend,
  handleAscend,
  setPendingConfirm,
  setPendingBack,
}: {
  canAddCurrentDirectory: boolean;
  handleAdd: () => Promise<void>;
  canAscend: boolean;
  handleAscend: () => void;
  setPendingConfirm: (action: (() => void) | null) => void;
  setPendingBack: (action: (() => void) | null) => void;
}) {
  useEffect(() => {
    setPendingConfirm(canAddCurrentDirectory ? handleAdd : null);
    return () => setPendingConfirm(null);
  }, [canAddCurrentDirectory, handleAdd, setPendingConfirm]);

  useEffect(() => {
    setPendingBack(canAscend ? handleAscend : null);
    return () => setPendingBack(null);
  }, [canAscend, handleAscend, setPendingBack]);
}

function BrowseList({
  loading,
  error,
  result,
  isDrivesMode,
  leafFilter,
  filteredEntries,
  onSelect,
}: {
  loading: boolean;
  error: string | null;
  result: BrowseResult | null;
  isDrivesMode: boolean;
  leafFilter: string;
  filteredEntries: BrowseResult["entries"];
  onSelect: (entryName: string) => void;
}) {
  return (
    <CommandList className="max-h-80">
      <BrowseEntries
        error={error}
        result={result}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        filteredEntries={filteredEntries}
        onSelect={onSelect}
      />
      <BrowseMessages
        loading={loading}
        error={error}
        result={result}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        filteredEntries={filteredEntries}
      />
    </CommandList>
  );
}

function BrowseMessages({
  loading,
  error,
  result,
  isDrivesMode,
  leafFilter,
  filteredEntries,
}: {
  loading: boolean;
  error: string | null;
  result: BrowseResult | null;
  isDrivesMode: boolean;
  leafFilter: string;
  filteredEntries: BrowseResult["entries"];
}) {
  return (
    <>
      <BrowseLoadingMessage loading={loading} hasResult={Boolean(result)} />
      <BrowsePathErrorMessage error={error} />
      <BrowseResolutionWarning
        loading={loading}
        error={error}
        isExactDirectory={result?.isExactDirectory}
        isDrivesMode={isDrivesMode}
      />
      <BrowseEmptyMessage
        loading={loading}
        error={error}
        isDrivesMode={isDrivesMode}
        leafFilter={leafFilter}
        entryCount={filteredEntries.length}
      />
    </>
  );
}

function BrowseLoadingMessage({ loading, hasResult }: { loading: boolean; hasResult: boolean }) {
  if (!loading || hasResult) return null;
  return <CommandEmpty>Loading…</CommandEmpty>;
}

function BrowsePathErrorMessage({ error }: { error: string | null }) {
  if (!error) return null;
  return <CommandEmpty>{error}</CommandEmpty>;
}

function BrowseResolutionWarning({
  loading,
  error,
  isExactDirectory,
  isDrivesMode,
}: {
  loading: boolean;
  error: string | null;
  isExactDirectory: boolean | undefined;
  isDrivesMode: boolean;
}) {
  if (loading || error || isExactDirectory !== false || isDrivesMode) return null;

  return (
    <div data-testid="browse-resolution-warning" className="mx-3 mb-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
      This path is not a folder. Choose a listed folder or revise the path.
    </div>
  );
}

function BrowseEmptyMessage({
  loading,
  error,
  isDrivesMode,
  leafFilter,
  entryCount,
}: {
  loading: boolean;
  error: string | null;
  isDrivesMode: boolean;
  leafFilter: string;
  entryCount: number;
}) {
  if (loading || error || isDrivesMode || entryCount > 0) return null;

  return (
    <CommandEmpty>
      {leafFilter ? `No folders match "${leafFilter}".` : "No subfolders here."}
    </CommandEmpty>
  );
}

function BrowseEntries({
  error,
  result,
  isDrivesMode,
  leafFilter,
  filteredEntries,
  onSelect,
}: {
  error: string | null;
  result: BrowseResult | null;
  isDrivesMode: boolean;
  leafFilter: string;
  filteredEntries: BrowseResult["entries"];
  onSelect: (entryName: string) => void;
}) {
  if (error) return null;

  return (
    <CommandGroup heading={getEntriesHeading(result, isDrivesMode, leafFilter)}>
      {filteredEntries.map((entry) => (
        <CommandItem
          key={entry.name}
          value={entry.name}
          keywords={[entry.name]}
          onSelect={() => onSelect(entry.name)}
          className="group/row gap-2 px-2 py-1.5 text-body-small"
        >
          <Folder aria-hidden className="size-[1.4rem] shrink-0 text-muted group-aria-selected/row:text-ink" strokeWidth={1.5} />
          <span className="text-fade text-ink group-aria-selected/row:font-medium">{entry.name}</span>
          <ChevronRight aria-hidden className="ml-auto hidden size-[1.4rem] shrink-0 text-muted group-aria-selected/row:block" strokeWidth={1.5} />
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

// Naming the folder only once it can be added tells the user which folder Add would register.
function getEntriesHeading(result: BrowseResult | null, isDrivesMode: boolean, leafFilter: string): string {
  if (isDrivesMode) return "Drives";
  if (leafFilter !== "" || !isAddableFolder(result)) return "Folders";
  return `Folders in ${folderName(result?.path ?? "")}`;
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

function BrowseError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (!error) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2 text-xs" role="alert">
      <span className="text-muted">Check the path or retry the folder listing.</span>
      <Button type="button" size="compact" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function BrowseAddError({ addError }: { addError: string | null }) {
  if (!addError) return null;

  return (
    <p data-testid="browse-add-error" role="alert" className="px-2.5 pt-1 pb-1.5 text-caption text-destructive">
      {addError}
    </p>
  );
}

function OpenInFileManager({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="h-6 rounded-badge px-1.5 text-caption text-muted hover:text-ink"
    >
      Open in {FILE_MANAGER_NAME}
    </Button>
  );
}
