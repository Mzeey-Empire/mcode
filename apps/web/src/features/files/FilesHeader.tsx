import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FolderTree, MoreHorizontal, Search } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { PanelTabStrip, type PanelTabStripItem } from "@/components/panels/shell/PanelTabStrip";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { isMac } from "@/lib/platform";
import type { FileActions } from "./useFileActions";

const COPIED_FEEDBACK_MS = 1200;

/** Row 1: one tab per open file, with + opening Go to file. */
export function FilesTabStrip({
  openPaths,
  activePath,
  onSelect,
  onClose,
  onAdd,
}: {
  readonly openPaths: readonly string[];
  readonly activePath: string | null;
  readonly onSelect: (path: string) => void;
  readonly onClose: (path: string) => void;
  readonly onAdd: () => void;
}) {
  const items = useMemo<readonly PanelTabStripItem[]>(
    () =>
      openPaths.map((path) => ({
        id: path,
        label: path.slice(path.lastIndexOf("/") + 1),
        icon: <FileTypeIcon filePath={path} size={14} />,
      })),
    [openPaths],
  );
  return (
    <PanelHeaderSlot slot="leading">
      <PanelTabStrip
        items={items}
        activeId={activePath}
        label="Open files"
        addLabel="Go to file"
        onSelect={onSelect}
        onClose={onClose}
        onAdd={onAdd}
      />
    </PanelHeaderSlot>
  );
}

export interface FilesControlsRowProps {
  readonly treeOpen: boolean;
  /** The file the body shows, or null when the body shows the tree. */
  readonly shownPath: string | null;
  readonly actions: FileActions;
  readonly onToggleTree: () => void;
  readonly onRevealFolder: (folder: string) => void;
  readonly onGoToFile: () => void;
  readonly controls?: ReactNode;
}

/** Row 2: tree toggle, then the path pill (or the Go to file field when no file shows), view controls, then More. */
export function FilesControlsRow({ treeOpen, shownPath, actions, onToggleTree, onRevealFolder, onGoToFile, controls }: FilesControlsRowProps) {
  return (
    <PanelHeaderSlot slot="row2">
      <div className="@container flex h-10 min-w-0 flex-1 items-center gap-2">
        <IconButton shape="round" aria-label={treeOpen ? "Hide files tree" : "Show files tree"} pressed={treeOpen} onClick={onToggleTree}>
          <FolderTree />
        </IconButton>
        {shownPath ? <PathPill path={shownPath} onRevealFolder={onRevealFolder} /> : <GoToFileField onClick={onGoToFile} />}
        {shownPath ? controls : null}
        <MoreMenu path={shownPath} actions={actions} />
      </div>
    </PanelHeaderSlot>
  );
}

function GoToFileField({ onClick }: { readonly onClick: () => void }) {
  const binding = getKeybindingForCommand("files.goToFile");
  const keys = binding ? keybindingKeycaps(binding.key, isMac).join(" ") : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[18px] bg-selected px-3 text-left text-body-small text-muted"
    >
      <Search aria-hidden size={14} className="shrink-0" />
      <span className="text-fade min-w-0">{keys ? `Go to file · ${keys}` : "Go to file"}</span>
    </button>
  );
}

function PathPill({ path, onRevealFolder }: { readonly path: string; readonly onRevealFolder: (folder: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const segments = path.split("/");
  const name = segments.pop() ?? path;
  const copy = () => {
    void navigator.clipboard.writeText(path).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div data-testid="files-path-pill" className="text-fade flex h-8 min-w-0 flex-1 items-center rounded-[18px] bg-selected px-3 text-body-small">
      {segments.map((segment, index) => {
        const folder = segments.slice(0, index + 1).join("/");
        return (
          <span key={folder} className="flex shrink-0 items-center text-muted">
            <button type="button" className="hover:text-ink" aria-label={`Reveal ${folder} in tree`} onClick={() => onRevealFolder(folder)}>
              {segment}
            </button>
            <span aria-hidden className="px-0.5">/</span>
          </span>
        );
      })}
      <button type="button" className="shrink-0 text-ink" aria-label={`Copy ${path}`} onClick={copy}>
        {name}
      </button>
      {copied ? <span role="status" className="ml-2 shrink-0 text-caption text-muted">Copied</span> : null}
    </div>
  );
}

function MoreMenu({ path, actions }: { readonly path: string | null; readonly actions: FileActions }) {
  const reason = !path ? "Open a file first" : actions.canResolve ? null : "This checkout has no folder yet";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<IconButton shape="round" aria-label="More file actions"><MoreHorizontal /></IconButton>} />
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuItem label="Open in editor" disabledReason={reason} onClick={() => path && actions.openInEditor(path)} />
        <DropdownMenuItem label="Reveal" disabledReason={reason} onClick={() => path && actions.reveal(path)} />
        <DropdownMenuItem label="Copy path" disabledReason={reason} onClick={() => path && actions.copyAbsolutePath(path)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
