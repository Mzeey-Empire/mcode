import { FolderOpen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useInstalledEditors } from "@/hooks/useInstalledEditors";
import { getTransport } from "@/transport";
import { useToastStore } from "@/stores/toastStore";
import { VsCodeIcon, ZedIcon } from "../chat/EditorIcons";
import { CursorProviderIcon } from "../chat/ProviderIcons";

/** Editor identity for the rail's picker dropdown. */
interface EditorMeta {
  readonly id: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

/** Editor registry keyed by ID (mirrors detectEditors() output). */
const EDITOR_CONFIG: Record<
  string,
  { label: string; icon: (size: number) => React.ReactNode }
> = {
  code: { label: "VS Code", icon: (s) => <VsCodeIcon size={s} /> },
  cursor: { label: "Cursor", icon: (s) => <CursorProviderIcon size={s} /> },
  zed: { label: "Zed", icon: (s) => <ZedIcon size={s} /> },
};

/** Props for FileEditorPicker. */
interface FileEditorPickerProps {
  /** Absolute file path to open in the chosen editor. */
  readonly filePath: string;
  /** Absolute parent directory of the file — used for the Reveal action. */
  readonly dirPath: string;
  /** Optional line number to jump to when opening in an editor. */
  readonly line?: number;
  /** Element rendered as the dropdown trigger (typically a SideRail button). */
  readonly trigger: React.ReactElement;
}

/**
 * DropdownMenu picker for opening a single file in any installed editor at
 * a specific line, with a Reveal in file manager fallback. Mirrors the
 * existing OpenInEditorMenu pattern from the chat header but scoped to a
 * file (with optional goto-line) instead of the workspace directory.
 *
 * When no editors are detected, the menu collapses to just the Reveal item
 * — the file manager fallback is always available.
 */
export function FileEditorPicker({ filePath, dirPath, line, trigger }: FileEditorPickerProps) {
  const installedEditors = useInstalledEditors();
  const entries: EditorMeta[] = installedEditors
    .filter((id) => id in EDITOR_CONFIG)
    .map((id) => ({
      id,
      label: EDITOR_CONFIG[id].label,
      icon: EDITOR_CONFIG[id].icon(14),
    }));

  const handleOpenEditor = (editorId: string) => {
    const label = EDITOR_CONFIG[editorId]?.label ?? editorId;
    getTransport()
      .openInEditor(editorId, filePath, line)
      .catch((err: unknown) =>
        useToastStore
          .getState()
          .show(
            "error",
            `Could not open ${label}`,
            String((err as { message?: string })?.message ?? err),
          ),
      );
  };

  const handleReveal = () => {
    getTransport()
      .openInExplorer(dirPath)
      .catch((err: unknown) =>
        useToastStore
          .getState()
          .show(
            "error",
            "Couldn't open file manager",
            String((err as { message?: string })?.message ?? err),
          ),
      );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
        {entries.length > 0 && (
          <>
            {entries.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onClick={() => handleOpenEditor(entry.id)}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
              >
                {entry.icon}
                <span>{entry.label}</span>
                {line !== undefined && (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    :{line}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onClick={handleReveal}
          className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
        >
          <FolderOpen size={14} />
          <span>Reveal in file manager</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
