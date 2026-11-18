import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Files, FolderTree, Ellipsis, Search } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PanelHeaderSlot, PanelTitle } from "@/components/panels/shell/PanelHeader";
import { PanelTabStrip, type PanelTabStripItem } from "@/components/panels/shell/PanelTabStrip";
import { getKeybindingForCommand, keybindingKeycaps } from "@/lib/keybinding-manager";
import { basename } from "@/lib/path";
import { isMac } from "@/lib/platform";
import type { FileActions } from "./useFileActions";

const COPIED_FEEDBACK_MS = 1200;

/**
 * Row 1: one tab per open file, with + opening Go to file. With none open, row 1 names the
 * tool instead, because row 2's Go to file field already offers the same action.
 */
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
  if (openPaths.length === 0) {
    return (
      <PanelHeaderSlot slot="leading">
        <PanelTitle icon={<Files size={14} aria-hidden />}>Files</PanelTitle>
      </PanelHeaderSlot>
    );
  }
  return (
    <PanelHeaderSlot slot="leading">
      <div data-files-tool="" className="contents">
        <PanelTabStrip
          items={items}
          activeId={activePath}
          label="Open files"
          tool={{ icon: <Files />, name: "Files" }}
          addLabel="Go to file"
          onSelect={onSelect}
          onClose={onClose}
          onAdd={onAdd}
        />
      </div>
    </PanelHeaderSlot>
  );
}

export interface FilesControlsRowProps {
  /** Absolute folder the tree and Go to file read from, or null before the checkout resolves. */
  readonly checkoutPath: string | null;
  readonly treeOpen: boolean;
  /** The file the body shows, or null when the body shows the tree. */
  readonly shownPath: string | null;
  readonly actions: FileActions;
  readonly onToggleTree: () => void;
  readonly onRevealFolder: (folder: string) => void;
  readonly onGoToFile: () => void;
  /** Null when the body has no text to search, which disables the Find button. */
  readonly find: { readonly open: boolean; readonly onToggle: () => void } | null;
  /** View-kind controls (preview/source, image scale), shown only while a file shows. */
  readonly controls?: ReactNode;
}

/**
 * Row 2: tree toggle and checkout name, then the path pill (or the Go to file field when no file shows), view
 * controls, Find, then More.
 */
export function FilesControlsRow({ checkoutPath, treeOpen, shownPath, actions, onToggleTree, onRevealFolder, onGoToFile, find, controls }: FilesControlsRowProps) {
  const findShortcut = keybindingKeycaps(getKeybindingForCommand("files.findInFile")?.key ?? "mod+f", isMac);
  return (
    <PanelHeaderSlot slot="row2">
      <div data-files-tool="" className="@container flex h-10 min-w-0 flex-1 items-center gap-2">
        <IconButton shape="round" aria-label={treeOpen ? "Hide files tree" : "Show files tree"} pressed={treeOpen} onClick={onToggleTree}>
          <FolderTree />
        </IconButton>
        <CheckoutName path={checkoutPath} />
        {shownPath ? <PathPill path={shownPath} onRevealFolder={onRevealFolder} /> : <GoToFileField onClick={onGoToFile} />}
        {shownPath ? controls : null}
        {shownPath ? (
          <IconButton
            shape="round"
            aria-label="Find in file"
            tooltipShortcut={findShortcut}
            pressed={find?.open ?? false}
            disabled={!find}
            onClick={find?.onToggle}
          >
            <Search />
          </IconButton>
        ) : null}
        <MoreMenu path={shownPath} actions={actions} />
      </div>
    </PanelHeaderSlot>
  );
}

/**
 * Names the checkout the tree lists, because a thread can read a worktree rather than the project folder and
 * nothing else in the tool says which. Set like Terminal's working folder: name in ink, full path on hover.
 */
function CheckoutName({ path }: { readonly path: string | null }) {
  if (!path) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span data-testid="files-checkout-name" className="text-fade max-w-40 min-w-0 shrink font-mono text-xs text-ink">
            {basename(path)}
          </span>
        }
      />
      <TooltipContent className="max-w-72 break-all font-mono">{path}</TooltipContent>
    </Tooltip>
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
    // Plain breadcrumb text continuing the checkout name: a filled pill here read as a second copy of the active tab.
    <div data-testid="files-path-pill" className="flex h-8 min-w-0 flex-1 items-center font-mono text-xs">
      <span aria-hidden className="-ml-1 shrink-0 pr-1 text-muted">/</span>
      {/* The folders give way almost entirely before the file name starts to fade. */}
      {segments.length > 0 ? (
        <span className="text-fade flex shrink-[100] items-center">
          {segments.map((segment, index) => {
            const folder = segments.slice(0, index + 1).join("/");
            return (
              <span key={folder} className="flex shrink-0 items-center text-muted">
                <button type="button" className="hover:text-ink" aria-label={`Reveal ${folder} in tree`} onClick={() => onRevealFolder(folder)}>
                  {segment}
                </button>
                <span aria-hidden className="px-1">/</span>
              </span>
            );
          })}
        </span>
      ) : null}
      <button type="button" className="text-fade text-ink" aria-label={`Copy ${path}`} onClick={copy}>
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
      <DropdownMenuTrigger render={<IconButton shape="round" aria-label="More file actions"><Ellipsis /></IconButton>} />
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuItem label="Open in editor" disabledReason={reason} onClick={() => path && actions.openInEditor(path)} />
        <DropdownMenuItem label="Reveal" disabledReason={reason} onClick={() => path && actions.reveal(path)} />
        <DropdownMenuItem label="Copy path" disabledReason={reason} onClick={() => path && actions.copyAbsolutePath(path)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
