import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Folder } from "lucide-react";
import { FILE_LIST_MAX_PATHS } from "@mcode/contracts";
import { FileTypeIcon } from "@/components/ui/file-type-icon";
import { cn } from "@/lib/utils";
import type { FileChangeMark, FileTreeRow } from "./file-tree-model";

const ROW_HEIGHT = 28;
const INDENT_PX = 12;
const OVERSCAN = 12;

const MARK_TEXT_CLASS: Record<FileChangeMark, string> = {
  M: "text-primary",
  A: "text-success",
};

/** Props for {@link FileTree}. */
export interface FileTreeProps {
  readonly rows: readonly FileTreeRow[];
  readonly activePath: string | null;
  /** True when the server capped the list at {@link FILE_LIST_MAX_PATHS}. */
  readonly truncated: boolean;
  /** Row to scroll into view once, such as a folder revealed from the path pill. */
  readonly revealPath: string | null;
  readonly onRevealed: () => void;
  readonly onToggleFolder: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
}

/**
 * The Files tree: compact folders, git marks, and amber dots on folders that
 * hold changes. Rows are virtualized so a 100k-path repository costs only the
 * rows on screen.
 */
export function FileTree({ rows, activePath, truncated, revealPath, onRevealed, onToggleFolder, onOpenFile }: FileTreeProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.path ?? index,
    overscan: OVERSCAN,
    useFlushSync: false,
  });

  useEffect(() => {
    if (!revealPath) return;
    const index = rows.findIndex((row) => row.path === revealPath);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
    onRevealed();
  }, [onRevealed, revealPath, rows, virtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={viewportRef} role="tree" aria-label="Files" className="min-h-0 flex-1 overflow-auto">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            return (
              <div key={item.key} className="absolute inset-x-0" style={{ top: item.start, height: ROW_HEIGHT }}>
                {row.kind === "folder" ? (
                  <FolderRow row={row} onToggle={onToggleFolder} />
                ) : (
                  <FileRow row={row} active={row.path === activePath} onOpen={onOpenFile} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {truncated ? (
        <p className="shrink-0 px-2 py-1.5 text-caption text-muted">
          Showing {FILE_LIST_MAX_PATHS.toLocaleString("en-US")} files
        </p>
      ) : null}
    </div>
  );
}

const ROW_CLASS =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left text-body-small outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-focus";

function FolderRow({ row, onToggle }: { readonly row: Extract<FileTreeRow, { kind: "folder" }>; readonly onToggle: (path: string) => void }) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={row.expanded}
      aria-level={row.depth + 1}
      data-path={row.path}
      data-has-changes={row.hasChanges || undefined}
      className={cn(ROW_CLASS, "text-ink")}
      style={{ paddingLeft: 8 + row.depth * INDENT_PX }}
      onClick={() => onToggle(row.path)}
    >
      <ChevronRight aria-hidden size={14} className={cn("shrink-0 text-muted", row.expanded && "rotate-90")} />
      <Folder aria-hidden size={14} className="shrink-0 text-muted" />
      <span className="text-fade min-w-0 flex-1">{row.name}</span>
      {row.hasChanges ? (
        <span aria-label="Contains changes" className="size-1.5 shrink-0 rounded-full bg-warning" />
      ) : null}
    </button>
  );
}

function FileRow({
  row,
  active,
  onOpen,
}: {
  readonly row: Extract<FileTreeRow, { kind: "file" }>;
  readonly active: boolean;
  readonly onOpen: (path: string) => void;
}) {
  const tint = row.mark ? MARK_TEXT_CLASS[row.mark] : "text-ink";
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={active}
      data-path={row.path}
      className={cn(ROW_CLASS, active && "bg-selected")}
      // Files line up under their folder's name, past the chevron column.
      style={{ paddingLeft: 8 + row.depth * INDENT_PX + 20 }}
      onClick={() => onOpen(row.path)}
    >
      <FileTypeIcon filePath={row.path} size={14} className="shrink-0" />
      <span className={cn("text-fade min-w-0 flex-1", tint)}>{row.name}</span>
      {row.mark ? (
        <span aria-label={row.mark === "M" ? "Modified" : "Added"} className={cn("shrink-0 font-mono text-caption", tint)}>
          {row.mark}
        </span>
      ) : null}
    </button>
  );
}
