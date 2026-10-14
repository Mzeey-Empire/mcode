import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useElementWidth } from "@/hooks/useElementWidth";
import { SIDE_PANE_CONTENT_MIN_WIDTH, sidePaneDocks } from "@/lib/side-pane-dock";
import { CodeFileView } from "./CodeFileView";
import { FileTree } from "./FileTree";
import { FilesControlsRow, FilesTabStrip } from "./FilesHeader";
import { GoToFilePopover } from "./GoToFilePopover";
import { buildFilesTree, flattenFileTree, folderNodesToReveal, indexFileChanges } from "./file-tree-model";
import { FILES_SCOPE_DEFAULTS, getFilesScope, useFilesTabsStore, type FilesScopeState } from "./filesTabsStore";
import { useFileActions } from "./useFileActions";
import { useFilesData, type FilesData } from "./useFilesData";

const EMPTY_PATHS: readonly string[] = [];

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
      />
      <div ref={bodyRef} className="relative flex min-h-0 flex-1 flex-row overflow-hidden">
        <FilesBody scopeId={scopeId} state={state} layout={layout} data={data} tree={tree} actions={actions} onOpenFile={openFile} />
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
  onOpenFile,
}: {
  readonly scopeId: string;
  readonly state: FilesScopeState;
  readonly layout: FilesLayout;
  readonly data: FilesData;
  readonly tree: ReturnType<typeof buildFilesTree>;
  readonly actions: ReturnType<typeof useFileActions>;
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
