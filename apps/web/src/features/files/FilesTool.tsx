import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useElementWidth } from "@/hooks/useElementWidth";
import { SIDE_PANE_CONTENT_MIN_WIDTH, sidePaneDocks } from "@/lib/side-pane-dock";
import { CodeFileView, splitLines } from "./CodeFileView";
import { FileTree } from "./FileTree";
import { FilesControlsRow, FilesTabStrip } from "./FilesHeader";
import { FindInFileBar } from "./FindInFileBar";
import { GoToFilePopover } from "./GoToFilePopover";
import { buildFilesTree, flattenFileTree, folderNodesToReveal, indexFileChanges } from "./file-tree-model";
import { FILES_SCOPE_DEFAULTS, getFilesScope, useFilesTabsStore, type FilesScopeState } from "./filesTabsStore";
import { useFileActions } from "./useFileActions";
import { useFilesData, type FileReadState, type FilesData } from "./useFilesData";
import { useFindInFile, type FindHighlight } from "./useFindInFile";

const EMPTY_PATHS: readonly string[] = [];
const NO_LINES: readonly string[] = [];

export interface FilesToolProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  /** The thread id, or the workspace id for the threadless panel. */
  readonly scopeId: string;
}

interface FilesLayout {
  readonly dockedTree: boolean;
  readonly body: "tree" | "file";
}

/**
 * The tree docks beside the code when both fit; otherwise it is a body view the
 * round tree button toggles. With no file open the tree is always the body.
 */
export function filesLayout(bodyWidth: number, state: FilesScopeState): FilesLayout {
  if (state.activePath === null) return { dockedTree: false, body: "tree" };
  if (sidePaneDocks(bodyWidth, state.treeWidth)) return { dockedTree: state.treeOpen, body: "file" };
  return { dockedTree: false, body: state.treeOpen ? "tree" : "file" };
}

function useFilesScopeState(scopeId: string): FilesScopeState {
  return useFilesTabsStore((store) => store.scopes[scopeId] ?? FILES_SCOPE_DEFAULTS);
}

/**
 * Find state for the file the body shows. The bar only exists while that file has text,
 * so opening Find on the tree or a binary file waits until a searchable file shows.
 */
function useFindBar(scopeId: string, requested: boolean, read: FileReadState | undefined, bodyRef: RefObject<HTMLElement | null>) {
  const text = textOf(read);
  const open = requested && text !== null;
  const lines = useMemo(() => (open && text !== null ? splitLines(text) : NO_LINES), [open, text]);
  const find = useFindInFile(lines);
  const setOpen = (next: boolean) => {
    useFilesTabsStore.getState().setFindOpen(scopeId, next);
    // Closing from the field leaves focus on a vanished input; the code is where reading continues.
    if (!next) bodyRef.current?.querySelector<HTMLElement>("[data-code-viewport]")?.focus();
  };
  return {
    header: text === null ? null : { open, onToggle: () => setOpen(!open) },
    bar: open ? <FindInFileBar find={find} onClose={() => setOpen(false)} /> : null,
    highlight: open ? find : null,
  };
}

/** The searchable text of a loaded file, or null for anything else (loading, binary, empty, too large). */
function textOf(read: FileReadState | undefined): string | null {
  return read?.status === "ready" && read.result.kind === "text" && read.result.content.length > 0 ? read.result.content : null;
}

/**
 * The Files tool: project files for the panel scope with tabs, a tree, a code
 * view, and Go to file. Distinct from Review's Files navigator, which lists
 * only changed files.
 */
export function FilesTool({ workspaceId, threadId, scopeId }: FilesToolProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyWidth = useElementWidth(bodyRef);
  const state = useFilesScopeState(scopeId);
  const scope = useMemo(() => ({ workspaceId, threadId }), [workspaceId, threadId]);
  const data = useFilesData(scope, state.openPaths);
  const actions = useFileActions(workspaceId, threadId);
  const layout = filesLayout(bodyWidth, state);
  const store = useFilesTabsStore.getState;
  const setGoToFileOpen = (open: boolean) => store().setGoToFileOpen(scopeId, open);
  const tree = useMemo(() => buildFilesTree(data.list?.paths ?? EMPTY_PATHS), [data.list]);
  const shownPath = layout.body === "file" ? state.activePath : null;
  const findBar = useFindBar(scopeId, state.findOpen, shownPath ? data.reads[shownPath] : undefined, bodyRef);

  const openFile = useCallback(
    (path: string, beside = false) => {
      store().openFile(scopeId, path, { activate: !beside });
      // A tree in the body would hide the file the user just picked.
      if (!beside && !sidePaneDocks(bodyRef.current?.getBoundingClientRect().width ?? 0, getFilesScope(scopeId).treeWidth)) {
        store().setTreeOpen(scopeId, false);
      }
    },
    [scopeId, store],
  );
  const revealFolder = useCallback(
    (folder: string) => store().reveal(scopeId, folderNodesToReveal(tree, folder), folder),
    [scopeId, store, tree],
  );

  return (
    <div data-files-tool="" className="absolute inset-0 flex min-h-0 flex-col overflow-hidden">
      <FilesTabStrip
        openPaths={state.openPaths}
        activePath={state.activePath}
        onSelect={(path) => store().setActiveFile(scopeId, path)}
        onClose={(path) => store().closeFile(scopeId, path)}
        onAdd={() => setGoToFileOpen(true)}
      />
      <FilesControlsRow
        treeOpen={layout.dockedTree || layout.body === "tree"}
        shownPath={shownPath}
        actions={actions}
        onToggleTree={() => store().setTreeOpen(scopeId, !(layout.dockedTree || layout.body === "tree"))}
        onRevealFolder={revealFolder}
        onGoToFile={() => setGoToFileOpen(true)}
        find={findBar.header}
      />
      {findBar.bar}
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-row overflow-hidden">
        <FilesBody scopeId={scopeId} state={state} layout={layout} data={data} tree={tree} actions={actions} findHighlight={findBar.highlight} onOpenFile={openFile} />
        {state.goToFileOpen ? (
          <GoToFilePopover
            paths={data.list?.paths ?? EMPTY_PATHS}
            onClose={() => setGoToFileOpen(false)}
            onPick={(path, beside) => {
              setGoToFileOpen(false);
              openFile(path, beside);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function FilesBody({
  scopeId,
  state,
  layout,
  data,
  tree,
  actions,
  findHighlight,
  onOpenFile,
}: {
  readonly scopeId: string;
  readonly state: FilesScopeState;
  readonly layout: FilesLayout;
  readonly data: FilesData;
  readonly tree: ReturnType<typeof buildFilesTree>;
  readonly actions: ReturnType<typeof useFileActions>;
  readonly findHighlight: FindHighlight | null;
  readonly onOpenFile: (path: string) => void;
}) {
  const changeIndex = useMemo(() => indexFileChanges(data.changes), [data.changes]);
  const rows = useMemo(() => flattenFileTree(tree, state.expandedFolders, changeIndex), [tree, state.expandedFolders, changeIndex]);
  const clearReveal = useCallback(() => useFilesTabsStore.getState().clearReveal(scopeId), [scopeId]);
  const treeView = data.list ? (
    <FileTree
      rows={rows}
      activePath={state.activePath}
      truncated={data.list.truncated}
      revealPath={state.revealPath}
      onRevealed={clearReveal}
      onToggleFolder={(path) => useFilesTabsStore.getState().toggleFolder(scopeId, path)}
      onOpenFile={onOpenFile}
    />
  ) : (
    <p className="px-4 py-3 font-mono text-code-small text-muted">{data.listError ?? "Loading…"}</p>
  );

  if (layout.body === "tree" || !state.activePath) {
    return <div data-testid="files-tree-body" className="flex min-h-0 min-w-0 flex-1 flex-col p-1.5">{treeView}</div>;
  }
  const activePath = state.activePath;
  return (
    <>
      {layout.dockedTree ? (
        <DockedTreePane scopeId={scopeId} width={state.treeWidth}>
          {treeView}
        </DockedTreePane>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <CodeFileView
          path={activePath}
          state={data.reads[activePath] ?? { status: "loading" }}
          onOpenInEditor={(line) => actions.openInEditor(activePath, line)}
          onCloseTab={() => useFilesTabsStore.getState().closeFile(scopeId, activePath)}
          find={findHighlight}
        />
      </div>
    </>
  );
}

function DockedTreePane({ scopeId, width, children }: { readonly scopeId: string; readonly width: number; readonly children: React.ReactNode }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    const maxDockedWidth = (target.parentElement?.parentElement?.getBoundingClientRect().width ?? Infinity) - SIDE_PANE_CONTENT_MIN_WIDTH;
    target.setPointerCapture(event.pointerId);
    // Past the widest width that still docks, the layout switches to the body view and ends the drag.
    const onMove = (move: PointerEvent) =>
      useFilesTabsStore.getState().setTreeWidth(scopeId, Math.min(startWidth + (move.clientX - startX), maxDockedWidth));
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };
  return (
    <div
      data-testid="files-docked-tree"
      className="relative flex min-h-0 shrink-0 flex-col border-r border-border p-1.5"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize files tree"
        className="absolute inset-y-0 right-0 w-1 cursor-col-resize"
        onPointerDown={onPointerDown}
      />
      {children}
    </div>
  );
}
