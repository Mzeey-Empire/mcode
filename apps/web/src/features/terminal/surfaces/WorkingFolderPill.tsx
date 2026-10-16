import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const COPIED_FEEDBACK_MS = 1200;

/** Splits a path into the folder that holds its last segment and that segment, keeping the separator on the parent. */
export function splitWorkingFolder(path: string): { readonly parent: string; readonly name: string } {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0 || index === trimmed.length - 1) return { parent: "", name: trimmed || path };
  return { parent: trimmed.slice(0, index + 1), name: trimmed.slice(index + 1) };
}

interface WorkingFolderPillProps {
  readonly path: string | null;
  readonly onOpenInEditor: () => void;
  readonly editorReason: string | null;
  readonly onOpenInFileManager: () => void;
}

/**
 * Row-2 pill for a shell's working folder: parent muted, folder name ink. On overflow
 * the parent fades out so the folder name stays readable. Clicking copies the full path; the chevron opens the folder elsewhere.
 */
export function WorkingFolderPill({ path, onOpenInEditor, editorReason, onOpenInFileManager }: WorkingFolderPillProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!path) {
    return <div data-testid="working-folder-pill" className="h-8 min-w-0 flex-1" />;
  }
  const { parent, name } = splitWorkingFolder(path);
  const copy = () => {
    void navigator.clipboard.writeText(path).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div
      data-testid="working-folder-pill"
      className="flex h-8 min-w-0 flex-1 items-center rounded-[18px] bg-selected pr-1 pl-3 text-body-small"
    >
      <Tooltip open={copied ? true : undefined}>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Copy ${path}`}
              onClick={copy}
              className="flex min-w-0 flex-1 items-baseline text-left font-mono text-xs"
            >
              <span className="text-fade text-muted">{parent}</span>
              <span className="shrink-0 text-ink">{name}</span>
            </button>
          }
        />
        <TooltipContent className="max-w-72 break-all font-mono">{copied ? "Copied" : path}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton size="inline-sm" aria-label="Open working folder in">
              <ChevronDown />
            </IconButton>
          }
        />
        <DropdownMenuContent align="start" sideOffset={6}>
          <DropdownMenuItem label="Open in editor" disabledReason={editorReason} onClick={onOpenInEditor} />
          <DropdownMenuItem label="Open in file manager" onClick={onOpenInFileManager} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
