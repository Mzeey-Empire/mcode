import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FileSearch,
  Files,
  WrapText,
  Columns2,
  MoreHorizontal,
  RefreshCw,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";
import type { ReviewFileChange } from "@mcode/contracts";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { useDiffStore, type SelectedFile } from "@/stores/diffStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { ReviewDiffView } from "./ReviewDiffView";
import { ReviewToolbarSlotContext } from "./review-toolbar-slot";

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
  source: SelectedFile["source"];
  id: string;
  /** Thread that owns these files, used to scope the inline diff cache. */
  threadId: string;
  /** When true every file entry starts expanded (used for the latest turn). */
  defaultFilesExpanded?: boolean;
  /** Extra identity for mutable comparisons whose ref names can stay stable while content changes. */
  cacheVersion?: string | number;
  /** Whether this comparison can change and exposes manual refresh. */
  refreshable?: boolean;
  /** Whether the parent is retaining settled content while a replacement loads. */
  refreshing?: boolean;
  /** Refresh the complete comparison through the owning Review lifecycle. */
  onRefresh?: () => void;
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
 * inline comments. The toolbar above it stays in the outer scroll region.
 */
export function FileList({
  files,
  source,
  id,
  threadId,
  defaultFilesExpanded = false,
  cacheVersion = 0,
  refreshable = false,
  refreshing = false,
  onRefresh,
  jumpViewKey,
}: FileListProps) {
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<{ path: string; token: number } | null>(null);
  const [highlightPath, setHighlightPath] = useState<string | null>(null);
  const jumpTokenRef = useRef(0);
  const highlightClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A consumed keyed jump can fire against a comparison that is about to be
  // swapped out (the view's operand changed but its replacement is still
  // loading); arm a one-shot re-jump keyed on the comparison id.
  const reJumpRef = useRef<{ path: string; id: string } | null>(null);
  const sortedFiles = useMemo(
    () => files.slice().sort((a, b) => a.path.localeCompare(b.path)),
    [files],
  );

  // Report this view's changed-file count so the toolbar can badge it. The
  // active Review view always renders exactly one FileList, so its count is the
  // view's count; clear on unmount so a switching view doesn't show a stale badge.
  const setReviewFileCount = useDiffStore((s) => s.setReviewFileCount);
  useEffect(() => {
    setReviewFileCount(files.length);
    return () => setReviewFileCount(null);
  }, [files.length, setReviewFileCount]);

  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  // FileList's `threadId` prop is the diff scope (thread or workspace id), which
  // is also the key the Files navigator visibility is stored under.
  const filesVisible = useDiffStore((s) => s.reviewFilesVisibleByScope[threadId] ?? false);
  const setReviewFilesVisible = useDiffStore((s) => s.setReviewFilesVisible);
  const renderMode = useDiffStore((s) => s.renderMode);
  const setRenderMode = useDiffStore((s) => s.setRenderMode);
  const toggleLineWrap = useDiffStore((s) => s.toggleLineWrap);
  const lineWrap = useDiffStore((s) => (activeThreadId ? s.getLineWrap(activeThreadId) : true));
  const setBulkDiffExpand = useDiffStore((s) => s.setBulkDiffExpand);
  const bulkDiffExpand = useDiffStore((s) => s.bulkDiffExpand);
  const allExpanded = bulkDiffExpand?.expand ?? defaultFilesExpanded;

  useEffect(() => {
    return () => {
      if (highlightClearRef.current) clearTimeout(highlightClearRef.current);
    };
  }, []);

  const jumpToFile = useCallback((path: string) => {
    const token = ++jumpTokenRef.current;
    setJumpOpen(false);
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
      const target = sortedFiles.find((f) => normalizeJumpPath(f.path) === requested);
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
      const target = sortedFiles.find(
        (f) => normalizeJumpPath(f.path) === armed.path,
      );
      if (target) jumpToFile(target.path);
    }
    consumeJumpRequest(useDiffStore.getState().reviewFileJumpRequest);
    return useDiffStore.subscribe((state, prev) => {
      if (state.reviewFileJumpRequest === prev.reviewFileJumpRequest) return;
      consumeJumpRequest(state.reviewFileJumpRequest);
    });
  }, [id, jumpToFile, jumpViewKey, sortedFiles, threadId]);

  if (files.length === 0) {
    return (
      <p className="px-3 py-1 text-[11px] text-muted-foreground">No files changed</p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileListToolbar
        activeThreadId={activeThreadId}
        filesVisible={filesVisible}
        onToggleFiles={() => setReviewFilesVisible(threadId, !filesVisible)}
        refreshable={refreshable}
        refreshInProgress={refreshing}
        onRefresh={onRefresh}
        lineWrap={lineWrap}
        toggleLineWrap={toggleLineWrap}
        allExpanded={allExpanded}
        onToggleAll={() => setBulkDiffExpand(!allExpanded)}
        jumpOpen={jumpOpen}
        onJumpOpenChange={setJumpOpen}
        sortedFiles={sortedFiles.map((f) => f.path)}
        onJumpToFile={jumpToFile}
        renderMode={renderMode}
        onToggleRenderMode={() =>
          setRenderMode(renderMode === "unified" ? "side-by-side" : "unified")
        }
      />
      {/* jsdom and non-DOM environments have no Worker; pierre falls back to
          main-thread highlighting when no pool provider is present. */}
      {typeof Worker === "undefined" ? (
        <ReviewDiffView
          files={sortedFiles}
          source={source}
          id={id}
          threadId={threadId}
          cacheVersion={cacheVersion}
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
          files={sortedFiles}
          source={source}
          id={id}
          threadId={threadId}
          cacheVersion={cacheVersion}
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

/** Props for the persistent controls above a changed-file list. */
interface FileListToolbarProps {
  activeThreadId: string | null;
  filesVisible: boolean;
  onToggleFiles: () => void;
  refreshable: boolean;
  refreshInProgress: boolean;
  onRefresh?: () => void;
  lineWrap: boolean;
  toggleLineWrap: (threadId: string) => void;
  allExpanded: boolean;
  onToggleAll: () => void;
  jumpOpen: boolean;
  onJumpOpenChange: (open: boolean) => void;
  sortedFiles: string[];
  onJumpToFile: (path: string) => void;
  renderMode: "unified" | "side-by-side";
  onToggleRenderMode: () => void;
}

/** Renders the controls for review display, navigation, and refresh. */
function FileListToolbar({
  activeThreadId,
  filesVisible,
  onToggleFiles,
  refreshable,
  refreshInProgress,
  onRefresh,
  lineWrap,
  toggleLineWrap,
  allExpanded,
  onToggleAll,
  jumpOpen,
  onJumpOpenChange,
  sortedFiles,
  onJumpToFile,
  renderMode,
  onToggleRenderMode,
}: FileListToolbarProps) {
  const toolbarSlot = useContext(ReviewToolbarSlotContext);
  const controls = (
    <>
      <ReviewOptionsMenu
        activeThreadId={activeThreadId}
        refreshable={refreshable}
        refreshInProgress={refreshInProgress}
        onRefresh={onRefresh}
        lineWrap={lineWrap}
        toggleLineWrap={toggleLineWrap}
        allExpanded={allExpanded}
        onToggleAll={onToggleAll}
      />
      {refreshInProgress ? (
        <span
          role="status"
          aria-label="Refreshing comparison"
          data-testid="review-refresh-progress"
          className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground/55"
        >
          <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
        </span>
      ) : null}
      <FilesToggle filesVisible={filesVisible} onToggle={onToggleFiles} />
      <FileJumpPopover
        open={jumpOpen}
        onOpenChange={onJumpOpenChange}
        files={sortedFiles}
        onJumpToFile={onJumpToFile}
      />
      <RenderModeToggle renderMode={renderMode} onToggle={onToggleRenderMode} />
    </>
  );
  // The Review panel supplies a slot inside the top toolbar row so the two
  // rows collapse into one. Standalone renders fall back to a sticky bar.
  if (toolbarSlot) return createPortal(controls, toolbarSlot);
  return (
    <div className="sticky top-0 z-20 flex items-center gap-0.5 bg-background/95 px-2 py-1.5 shadow-[0_8px_12px_-12px_oklch(0_0_0/0.35)] backdrop-blur-sm">
      {controls}
    </div>
  );
}

/** Props for the Files navigator toggle. */
interface FilesToggleProps {
  filesVisible: boolean;
  onToggle: () => void;
}

/** Toggles the docked/floating Files navigator for the active comparison. */
function FilesToggle({ filesVisible, onToggle }: FilesToggleProps) {
  const label = filesVisible ? "Hide files" : "Show files";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={filesVisible}
            data-testid="review-files-toggle"
            className={cn(
              "h-6 w-6 transition-colors",
              filesVisible
                ? "bg-muted text-foreground"
                : "text-muted-foreground/50 hover:bg-muted/40 hover:text-foreground/70",
            )}
            onClick={onToggle}
          >
            <Files size={13} aria-hidden />
          </Button>
        }
      />
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Props for the review-options menu. */
interface ReviewOptionsMenuProps {
  activeThreadId: string | null;
  refreshable: boolean;
  refreshInProgress: boolean;
  onRefresh?: () => void;
  lineWrap: boolean;
  toggleLineWrap: (threadId: string) => void;
  allExpanded: boolean;
  onToggleAll: () => void;
}

/** Renders the options that change how the current review appears. */
function ReviewOptionsMenu({
  activeThreadId,
  refreshable,
  refreshInProgress,
  onRefresh,
  lineWrap,
  toggleLineWrap,
  allExpanded,
  onToggleAll,
}: ReviewOptionsMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Review options"
        data-testid="review-options-menu"
        className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/50 outline-none transition-colors hover:bg-muted/40 hover:text-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <MoreHorizontal size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[190px]">
        {refreshable ? (
          <DropdownMenuItem
            onClick={onRefresh}
            disabled={refreshInProgress}
            data-testid="review-option-refresh"
            className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs"
          >
            <RefreshCw size={13} className={cn("text-muted-foreground", refreshInProgress && "animate-spin")} />
            {refreshInProgress ? "Refreshing" : "Refresh"}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          disabled={!activeThreadId}
          onClick={() => {
            if (activeThreadId) toggleLineWrap(activeThreadId);
          }}
          data-testid="review-option-word-wrap"
          className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs data-disabled:cursor-not-allowed"
        >
          <WrapText size={13} className="text-muted-foreground" />
          {lineWrap ? "Disable word wrap" : "Enable word wrap"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onToggleAll}
          data-testid="review-option-toggle-all"
          className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs"
        >
          {allExpanded ? (
            <ChevronsDownUp size={13} className="text-muted-foreground" />
          ) : (
            <ChevronsUpDown size={13} className="text-muted-foreground" />
          )}
          {allExpanded ? "Collapse all" : "Expand all"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Props for the changed-file jump popover. */
interface FileJumpPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: string[];
  onJumpToFile: (path: string) => void;
}

/** Renders the searchable changed-file jump control. */
function FileJumpPopover({ open, onOpenChange, files, onJumpToFile }: FileJumpPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Jump to file"
                data-testid="review-file-jump-trigger"
                className="h-6 w-6 text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground"
              >
                <FileSearch size={13} aria-hidden="true" />
              </Button>
            }
          />
        </TooltipTrigger>
        <TooltipContent side="left" className="text-xs">
          Jump to file
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={6} className="w-[min(360px,calc(100vw-2rem))] p-0">
        <Command className="rounded-lg">
          <CommandInput
            autoFocus
            placeholder="Jump to file"
            aria-label="Jump to file"
            data-testid="review-file-filter"
            className="h-9 font-mono text-[11px]"
          />
          <CommandList className="max-h-72">
            <CommandEmpty>No files found</CommandEmpty>
            <CommandGroup heading="Changed files">
              {files.map((file) => (
                <FileJumpItem key={file} filePath={file} onSelect={onJumpToFile} />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Props for one changed-file jump result. */
interface FileJumpItemProps {
  filePath: string;
  onSelect: (path: string) => void;
}

/** Renders a changed-file jump result. */
function FileJumpItem({ filePath, onSelect }: FileJumpItemProps) {
  const basename = getFileBasename(filePath);
  const parent = getParentPath(filePath);

  return (
    <CommandItem
      value={filePath}
      data-testid={`review-file-jump-item-${filePath}`}
      onSelect={() => onSelect(filePath)}
      className="items-start gap-2 px-2 py-2"
    >
      <FileTypeIcon filePath={filePath} size={14} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[11px] text-foreground/85">{basename}</span>
        {parent && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground/65">
            {parent}/
          </span>
        )}
      </span>
    </CommandItem>
  );
}

/** Props for the unified/split render-mode control. */
interface RenderModeToggleProps {
  renderMode: "unified" | "side-by-side";
  onToggle: () => void;
}

/** Renders the unified/split render-mode control. */
function RenderModeToggle({ renderMode, onToggle }: RenderModeToggleProps) {
  const isSideBySide = renderMode === "side-by-side";
  const label = isSideBySide ? "Switch to unified view" : "Switch to split view";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onToggle}
            aria-pressed={isSideBySide}
            aria-label={label}
            className={cn(
              "h-6 w-6 transition-colors",
              isSideBySide
                ? "bg-muted text-foreground"
                : "text-muted-foreground/50 hover:bg-muted/40 hover:text-foreground/70",
            )}
          >
            <Columns2 size={13} />
          </Button>
        }
      />
      <TooltipContent side="bottom" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function getFileBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function getParentPath(filePath: string): string {
  const index = filePath.replace(/\\/g, "/").lastIndexOf("/");
  return index >= 0 ? filePath.slice(0, index) : "";
}
