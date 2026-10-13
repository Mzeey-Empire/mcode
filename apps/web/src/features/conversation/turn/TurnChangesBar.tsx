import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Diff,
  ExternalLink,
  Folder,
} from "lucide-react";
import { FileEditorPicker } from "@/components/diff/FileEditorPicker";
import { openInAppIcon } from "@/components/chat/openInAppIcons";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { basename, dirname, joinPaths } from "@/lib/path";
import { showRightPanelAdaptive } from "@/lib/right-panel-layout";
import { cn } from "@/lib/utils";
import { useDiffStore } from "@/stores/diffStore";
import { readThreadRecord } from "@/stores/thread-selectors";
import { useToastStore } from "@/stores/toastStore";
import {
  allFolderIds,
  buildChangesTree,
  initialCollapse,
  turnChangePaths,
  visibleRows,
  type ChangedFile,
  type ChangesFolder,
  type ChangesFooter,
  type ChangesRow,
  type ChangesTree,
  type TurnChanges,
} from "./changes-tree";
import { TurnRevertBarConfirm, useRevertTurnDisabledReason } from "../turn-revert/TurnRevertBarConfirm";
import { TurnMenu } from "./TurnMenu";
import { useTurnChanges } from "./useTurnChanges";

/** Props for {@link TurnChangesBar}. */
export interface TurnChangesBarProps {
  /** Thread the turn belongs to. The bar reads only this thread's snapshots. */
  readonly threadId: string | null | undefined;
  /** Client id of the turn's assistant message. */
  readonly messageId: string;
  /** Paths the transcript recorded for the turn, used until a snapshot answers. */
  readonly filesChanged: readonly string[];
  /** The newest turn's bar opens expanded; older bars open collapsed. */
  readonly isLatestTurn: boolean;
  /** messageId -> manual expanded override. A ref so it survives virtualizer remounts. */
  readonly manualExpandRef?: React.RefObject<Map<string, boolean>>;
}

const ICON_BUTTON_CLASS =
  "flex size-[2.8rem] shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:bg-hover hover:text-ink focus-visible:ring-1 focus-visible:ring-focus";

const ROW_ACTION_CLASS =
  "flex size-[2.4rem] shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:text-ink focus-visible:ring-1 focus-visible:ring-focus";

/**
 * Opens the Changes tab on the Turn view pinned to this turn. The bar never
 * follows latest: its turn is the latest with changes, which can be older
 * than the newest turn the Turn view would follow. The turn is selected even when its snapshot is gone: the
 * comparison then says so, where switching to All turns would show a
 * different diff.
 */
function openTurnReview(threadId: string, messageId: string): string | null {
  const workspaceId = useWorkspaceStore.getState().threads.find((t) => t.id === threadId)?.workspace_id;
  if (!workspaceId) return null;
  const store = useDiffStore.getState();
  showRightPanelAdaptive(workspaceId, threadId);
  store.setRightPanelTab(workspaceId, threadId, "changes");
  const serverMessageId = readThreadRecord(threadId).serverMessageIds[messageId] ?? messageId;
  store.setReviewTurnForThread(threadId, serverMessageId);
  // Pin the pick as the per-thread override so the live default cannot
  // revert this deliberate choice (ADR-0011).
  store.setReviewViewForThread(threadId, "turn");
  return `turn:${serverMessageId}`;
}

function copyText(text: string, copiedTitle: string, failedTitle: string): void {
  const toast = useToastStore.getState();
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) {
    toast.show({ kind: "failed", title: failedTitle, meta: "Clipboard API is unavailable in this environment." });
    return;
  }
  clipboard.writeText(text).then(
    () => toast.show({ kind: "info", title: copiedTitle }),
    (error: unknown) => toast.show({ kind: "failed", title: failedTitle, meta: String(error) }),
  );
}

/** Expanded state that defaults by recency and remembers a manual toggle per turn. */
function useTurnExpanded(
  messageId: string,
  isLatestTurn: boolean,
  manualExpandRef: TurnChangesBarProps["manualExpandRef"],
): [boolean, () => void, () => void] {
  const [expanded, setExpanded] = useState(() => manualExpandRef?.current?.get(messageId) ?? isLatestTurn);

  useEffect(() => {
    setExpanded(manualExpandRef?.current?.get(messageId) ?? isLatestTurn);
  }, [isLatestTurn, messageId, manualExpandRef]);

  const toggle = useCallback(() => {
    setExpanded((previous) => {
      const next = !previous;
      manualExpandRef?.current?.set(messageId, next);
      return next;
    });
  }, [messageId, manualExpandRef]);

  const collapse = useCallback(() => {
    manualExpandRef?.current?.set(messageId, false);
    setExpanded(false);
  }, [messageId, manualExpandRef]);

  return [expanded, toggle, collapse];
}

/** Absolute root of the thread's checkout, for opening files in an editor. */
function useCheckoutRoot(threadId: string | null | undefined): string | null {
  return useWorkspaceStore((s) => {
    const thread = s.threads.find((t) => t.id === threadId);
    if (thread?.worktree_path) return thread.worktree_path;
    return s.workspaces.find((w) => w.id === thread?.workspace_id)?.path ?? null;
  });
}

/** Stand-in rows while counts load or after they fail: names only. */
function filesWithoutCounts(paths: readonly string[]): ChangedFile[] {
  return paths.map((path) => ({ path, kind: "modified", counts: { kind: "uncounted" }, editedLater: false, reverted: false }));
}

function listedFiles(changes: TurnChanges): readonly ChangedFile[] {
  return changes.status === "ready" ? changes.files : filesWithoutCounts(changes.paths);
}

function allFilesReverted(changes: TurnChanges): boolean {
  return changes.status === "ready" && changes.files.length > 0 && changes.files.every((file) => file.reverted);
}

/** Collapsed folders, reset to the tree's initial collapse whenever the file list changes. */
function useCollapsedFolders(tree: ChangesTree, treeKey: string) {
  const initial = useMemo(() => initialCollapse(tree), [tree]);
  const [manual, setManual] = useState<{ key: string; folders: ReadonlySet<string> } | null>(null);
  const collapsed = manual?.key === treeKey ? manual.folders : initial.collapsedFolders;
  const setCollapsed = useCallback(
    (folders: ReadonlySet<string>) => setManual({ key: treeKey, folders }),
    [treeKey],
  );
  return { collapsed, setCollapsed, initial };
}

/**
 * End-of-turn changes bar: the files a turn changed, grouped by folder, with
 * line counts and a way into Review. Collapsed it is a single summary row.
 */
export function TurnChangesBar({ threadId, messageId, filesChanged, isLatestTurn, manualExpandRef }: TurnChangesBarProps) {
  const { changes, snapshot, serverMessageId, listLoaded } = useTurnChanges(threadId, messageId, filesChanged);
  const [expanded, toggleExpanded, collapseList] = useTurnExpanded(messageId, isLatestTurn, manualExpandRef);
  const [confirming, setConfirming] = useState(false);
  const allReverted = allFilesReverted(changes);
  const revertDisabledReason = useRevertTurnDisabledReason(threadId, { snapshot, listLoaded, allReverted });
  const files = useMemo(() => listedFiles(changes), [changes]);
  const treeKey = files.map((file) => file.path).join("\n");
  const tree = useMemo(() => buildChangesTree(files), [files]);
  const { collapsed, setCollapsed, initial } = useCollapsedFolders(tree, treeKey);
  const listId = useId();

  const openReview = useCallback(() => {
    if (threadId) openTurnReview(threadId, messageId);
  }, [threadId, messageId]);
  const openFile = useCallback((path: string) => {
    if (!threadId) return;
    const viewKey = openTurnReview(threadId, messageId);
    // Requested after the view switch, which clears any pending jump.
    if (viewKey) useDiffStore.getState().requestReviewFileJump(threadId, path, viewKey);
  }, [threadId, messageId]);
  const copyPaths = useCallback(() => {
    copyText(turnChangePaths(changes).join("\n"), "File paths copied", "Couldn't copy file paths");
  }, [changes]);
  const openRevert = useCallback(() => {
    collapseList();
    setConfirming(true);
  }, [collapseList]);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const closeRevert = useCallback(() => {
    setConfirming(false);
    menuTriggerRef.current?.focus();
  }, []);

  const folderIds = useMemo(() => allFolderIds(tree), [tree]);
  const collapseControl = expanded && folderIds.length > 0
    ? {
        anyCollapsed: collapsed.size > 0,
        toggle: () => setCollapsed(collapsed.size > 0 ? new Set() : new Set(folderIds)),
      }
    : null;

  const header = (
    <BarHeader
      changes={changes}
      fileCount={files.length}
      expanded={expanded}
      listId={listId}
      onToggle={toggleExpanded}
      collapseControl={collapseControl}
      onReview={openReview}
      onCopyPaths={copyPaths}
      allReverted={allReverted}
      onRevertTurn={openRevert}
      revertDisabledReason={revertDisabledReason}
      menuTriggerRef={menuTriggerRef}
    />
  );

  const bar = expanded
    ? (
        <div className="flex flex-col gap-1.5 rounded-control bg-panel pt-2 pr-2 pb-2.5 pl-3" data-testid="turn-changes-bar">
          {header}
          <ChangesList
            id={listId}
            threadId={threadId}
            tree={tree}
            status={changes.status}
            collapsed={collapsed}
            rowLimit={initial.rowLimit}
            footer={initial.footer}
            onToggleFolder={(folderId) => setCollapsed(toggled(collapsed, folderId))}
            onOpenFile={openFile}
            onReview={openReview}
          />
        </div>
      )
    : (
        <div className="flex h-[4.4rem] items-center rounded-control bg-panel pr-2 pl-3" data-testid="turn-changes-bar">
          {header}
        </div>
      );
  // One wrapper in both states keeps the bar mounted, so closing the confirm can return focus to its menu.
  return (
    <div className="flex flex-col gap-2">
      {bar}
      {confirming && threadId && <TurnRevertBarConfirm threadId={threadId} messageId={serverMessageId} onClose={closeRevert} />}
    </div>
  );
}

function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

interface BarHeaderProps {
  readonly changes: TurnChanges;
  readonly fileCount: number;
  readonly expanded: boolean;
  readonly listId: string;
  readonly onToggle: () => void;
  readonly collapseControl: { readonly anyCollapsed: boolean; readonly toggle: () => void } | null;
  readonly onReview: () => void;
  readonly onCopyPaths: () => void;
  readonly allReverted: boolean;
  readonly onRevertTurn: () => void;
  readonly revertDisabledReason: string | null;
  readonly menuTriggerRef: RefObject<HTMLButtonElement | null>;
}

function BarHeader(props: BarHeaderProps) {
  const { changes, fileCount, expanded, listId, onToggle, collapseControl, onReview, onCopyPaths } = props;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        className="flex min-w-0 items-center gap-2 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-focus"
      >
        <Diff aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
        <span className="shrink-0 text-body-small font-medium text-ink">
          Changed {fileCount} {fileCount === 1 ? "file" : "files"}
        </span>
        <HeaderCounts changes={changes} />
        {props.allReverted && <span className="shrink-0 text-caption text-muted">reverted</span>}
        <Chevron aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
      </button>
      <span className="grow" />
      {collapseControl && (
        <button
          type="button"
          onClick={collapseControl.toggle}
          aria-label={collapseControl.anyCollapsed ? "Expand all folders" : "Collapse all folders"}
          className={ICON_BUTTON_CLASS}
        >
          {collapseControl.anyCollapsed
            ? <ChevronsUpDown aria-hidden size={14} strokeWidth={1.5} />
            : <ChevronsDownUp aria-hidden size={14} strokeWidth={1.5} />}
        </button>
      )}
      <button
        type="button"
        onClick={onReview}
        className="shrink-0 rounded-sm text-label text-muted outline-none transition-colors hover:text-ink focus-visible:ring-1 focus-visible:ring-focus"
      >
        Review
      </button>
      <TurnMenu
        onReviewChanges={onReview}
        onCopyFilePaths={onCopyPaths}
        onRevertTurn={props.onRevertTurn}
        revertDisabledReason={props.revertDisabledReason}
        triggerRef={props.menuTriggerRef}
      />
    </div>
  );
}

function HeaderCounts({ changes }: { readonly changes: TurnChanges }) {
  if (changes.status === "loading") {
    return <CountSkeleton label="Loading counts" className="w-[6.4rem]" />;
  }
  if (changes.status === "unavailable") {
    return <span className="shrink-0 text-caption text-muted">Counts unavailable</span>;
  }
  let additions = 0;
  let deletions = 0;
  for (const file of changes.files) {
    if (file.counts.kind !== "lines") continue;
    additions += file.counts.additions;
    deletions += file.counts.deletions;
  }
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-caption tabular-nums">
      {additions > 0 && <span className="text-success">+{additions}</span>}
      {deletions > 0 && <span className="text-error">−{deletions}</span>}
    </span>
  );
}

/** A count placeholder. A span, since it sits inside buttons where a div is invalid. */
function CountSkeleton({ className, label }: { readonly className: string; readonly label?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("h-[0.8rem] shrink-0 rounded-[0.4rem] bg-hover", className)}
    />
  );
}

interface ChangesListProps {
  readonly id: string;
  readonly threadId: string | null | undefined;
  readonly tree: ChangesTree;
  readonly status: TurnChanges["status"];
  readonly collapsed: ReadonlySet<string>;
  readonly rowLimit: number | null;
  readonly footer: ChangesFooter | null;
  readonly onToggleFolder: (folderId: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly onReview: () => void;
}

function ChangesList({ id, threadId, tree, status, collapsed, rowLimit, footer, onToggleFolder, onOpenFile, onReview }: ChangesListProps) {
  const rows = visibleRows(tree, collapsed);
  const shown = rowLimit === null ? rows : rows.slice(0, rowLimit);
  const checkoutRoot = useCheckoutRoot(threadId);
  return (
    <div id={id} className="flex w-full flex-col">
      {shown.map((row) => (
        <ChangesRowView
          key={rowKey(row)}
          row={row}
          status={status}
          checkoutRoot={checkoutRoot}
          onToggleFolder={onToggleFolder}
          onOpenFile={onOpenFile}
        />
      ))}
      {footer && <ListFooter footer={footer} onReview={onReview} />}
    </div>
  );
}

function rowKey(row: ChangesRow): string {
  return row.kind === "folder" ? `folder:${row.folder.id}` : `file:${row.file.path}`;
}

interface ChangesRowViewProps {
  readonly row: ChangesRow;
  readonly status: TurnChanges["status"];
  readonly checkoutRoot: string | null;
  readonly onToggleFolder: (folderId: string) => void;
  readonly onOpenFile: (path: string) => void;
}

function ChangesRowView({ row, status, checkoutRoot, onToggleFolder, onOpenFile }: ChangesRowViewProps) {
  if (row.kind === "folder") {
    return (
      <FolderRow
        folder={row.folder}
        depth={row.depth}
        collapsed={row.collapsed}
        showTotals={status === "ready"}
        onToggle={() => onToggleFolder(row.folder.id)}
      />
    );
  }
  return (
    <FileRow file={row.file} depth={row.depth} status={status} checkoutRoot={checkoutRoot} onOpen={() => onOpenFile(row.file.path)} />
  );
}

/** Rows indent 18px per level from an 8px base, as in Paper's changes list. */
function indent(depth: number): React.CSSProperties {
  return { paddingLeft: `${0.8 + 1.8 * depth}rem` };
}

interface FolderRowProps {
  readonly folder: ChangesFolder;
  readonly depth: number;
  readonly collapsed: boolean;
  readonly showTotals: boolean;
  readonly onToggle: () => void;
}

function FolderRow({ folder, depth, collapsed, showTotals, onToggle }: FolderRowProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      style={indent(depth)}
      className="flex h-[2.8rem] w-full shrink-0 items-center gap-2 pr-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus"
    >
      <Chevron aria-hidden size={12} strokeWidth={1.5} className="w-3 shrink-0 text-muted" />
      <Folder aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
      <span className="text-body-small text-muted text-fade">{folder.label}</span>
      <span className="shrink-0 text-caption text-muted">{folder.fileCount}</span>
      <span className="grow" />
      {showTotals
        ? <LineLanes additions={folder.additions} deletions={folder.deletions} />
        : <span className="w-[7.6rem] shrink-0" />}
      <span className="w-[5.6rem] shrink-0" />
    </button>
  );
}

interface FileRowProps {
  readonly file: ChangedFile;
  readonly depth: number;
  readonly status: TurnChanges["status"];
  readonly checkoutRoot: string | null;
  readonly onOpen: () => void;
}

function FileRow({ file, depth, status, checkoutRoot, onOpen }: FileRowProps) {
  const deleted = file.kind === "deleted";
  return (
    <div
      style={indent(depth)}
      className="group flex h-[2.8rem] w-full shrink-0 items-center gap-2 rounded-sm pr-1 hover:bg-hover"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Review ${file.path}`}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-focus"
      >
        <span aria-hidden className="w-3 shrink-0" />
        <FileTypeIcon filePath={file.path} size={16} className="shrink-0" />
        <span
          className={cn(
            "text-label text-fade",
            deleted ? "text-muted line-through" : "text-ink",
          )}
        >
          {basename(file.path)}
        </span>
        <FileAnnotations file={file} />
        <span className="grow" />
        <FileLanes file={file} status={status} />
      </button>
      <RowActions path={file.path} checkoutRoot={deleted ? null : checkoutRoot} />
    </div>
  );
}

function renameSource(file: ChangedFile): string | null {
  if (!file.oldPath) return null;
  return dirname(file.oldPath) === dirname(file.path) ? basename(file.oldPath) : file.oldPath;
}

function FileAnnotations({ file }: { readonly file: ChangedFile }) {
  const notes: ReactNode[] = [];
  if (file.kind === "added") notes.push(<span key="kind" className="text-success">new</span>);
  if (file.kind === "deleted") notes.push(<span key="kind" className="text-error">deleted</span>);
  const source = renameSource(file);
  if (source) notes.push(<span key="from" className="text-muted">from {source}</span>);
  if (file.reverted) notes.push(<span key="later" className="text-muted">reverted</span>);
  else if (file.editedLater) notes.push(<span key="later" className="text-muted">edited later</span>);
  if (notes.length === 0) return null;
  return <span className="flex shrink-0 gap-2 text-caption">{notes}</span>;
}

function FileLanes({ file, status }: { readonly file: ChangedFile; readonly status: TurnChanges["status"] }) {
  if (status === "loading") {
    return (
      <span className="flex w-[7.6rem] shrink-0 justify-end">
        <CountSkeleton className="w-[4.8rem]" />
      </span>
    );
  }
  if (file.counts.kind === "binary") {
    return <span className="flex w-[7.6rem] shrink-0 justify-end text-caption text-muted">Binary</span>;
  }
  if (file.counts.kind === "uncounted") return <span className="w-[7.6rem] shrink-0" />;
  return (
    <LineLanes
      additions={file.kind === "deleted" ? null : file.counts.additions}
      deletions={file.kind === "added" ? null : file.counts.deletions}
    />
  );
}

/** The +N and −N count columns. A null or zero side leaves its column empty, as the header does. */
function LineLanes({ additions, deletions }: { readonly additions: number | null; readonly deletions: number | null }) {
  return (
    <>
      <span className="flex w-[4rem] shrink-0 justify-end font-mono text-caption tabular-nums text-success">
        {additions ? `+${additions}` : null}
      </span>
      <span className="flex w-[3.6rem] shrink-0 justify-end font-mono text-caption tabular-nums text-error">
        {deletions ? `−${deletions}` : null}
      </span>
    </>
  );
}

function RowActions({ path, checkoutRoot }: { readonly path: string; readonly checkoutRoot: string | null }) {
  const canOpen = Boolean(window.desktopBridge) && checkoutRoot !== null;
  return (
    <span className="flex w-[5.6rem] shrink-0 items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
      {canOpen && checkoutRoot && <EditorAction absolutePath={joinPaths(checkoutRoot, path)} />}
      <button
        type="button"
        aria-label={`Copy path ${path}`}
        onClick={() => copyText(path, "Path copied", "Couldn't copy path")}
        className={ROW_ACTION_CLASS}
      >
        <Copy aria-hidden size={14} strokeWidth={1.5} />
      </button>
    </span>
  );
}

/** Opens the file in an editor, showing the first detected editor's icon. */
function EditorAction({ absolutePath }: { readonly absolutePath: string }) {
  const editor = useOpenInApps().find((app) => app.kind === "editor" && app.detected);
  return (
    <FileEditorPicker
      filePath={absolutePath}
      dirPath={dirname(absolutePath)}
      trigger={
        <button type="button" aria-label="Open in editor" className={ROW_ACTION_CLASS}>
          {editor ? openInAppIcon(editor.iconKey, 14) : <ExternalLink aria-hidden size={14} strokeWidth={1.5} />}
        </button>
      }
    />
  );
}

function ListFooter({ footer, onReview }: { readonly footer: ChangesFooter; readonly onReview: () => void }) {
  const noun = footer.kind === "folders"
    ? (footer.count === 1 ? "folder" : "folders")
    : (footer.count === 1 ? "more file" : "more files");
  return (
    <div className="flex gap-1 pl-2 text-label text-muted">
      <span>{`${footer.count} ${noun} ·`}</span>
      <button
        type="button"
        onClick={onReview}
        className="rounded-sm outline-none transition-colors hover:text-ink focus-visible:ring-1 focus-visible:ring-focus"
      >
        Review all
      </button>
    </div>
  );
}
