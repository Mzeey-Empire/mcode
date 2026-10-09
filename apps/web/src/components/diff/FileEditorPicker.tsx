import { FolderOpen } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useOpenInApps } from "@/hooks/useOpenInApps";
import { getTransport } from "@/transport";
import { useToastStore } from "@/stores/toastStore";
import { openInAppIcon } from "../chat/openInAppIcons";

/** Editor identity for the rail's picker dropdown. */
interface EditorMeta {
  readonly id: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

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
  /**
   * Notifies the parent when the dropdown opens or closes. The SideRail
   * uses this to keep the rail expanded while the picker is open — otherwise
   * focus moves into the portal-rendered popover and the rail collapses.
   */
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * DropdownMenu picker for opening a single file in any installed editor at
 * a specific line, with a Reveal in file manager fallback. Mirrors the
 * OpenInAppButton pattern from the chat header but scoped to a file (with
 * optional goto-line) instead of the workspace directory.
 *
 * When no editors are detected, the menu collapses to just the Reveal item
 * — the file manager fallback is always available.
 */
export function FileEditorPicker({
  filePath,
  dirPath,
  line,
  trigger,
  onOpenChange,
}: FileEditorPickerProps) {
  const apps = useOpenInApps();
  const editors = apps.filter((app) => app.kind === "editor" && app.detected);
  const fileManager = apps.find((app) => app.kind === "fileManager");
  const entries: EditorMeta[] = editors.map((app) => ({
    id: app.id,
    label: app.label,
    icon: openInAppIcon(app.iconKey, 14),
  }));

  const handleOpenEditor = (editorId: string) => {
    const label = editors.find((app) => app.id === editorId)?.label ?? editorId;
    getTransport()
      .openIn(editorId, filePath, line)
      .catch((err: unknown) =>
        useToastStore
          .getState()
          .show({
            kind: "failed",
            title: `Could not open ${label}`,
            meta: String((err as { message?: string })?.message ?? err),
          }),
      );
  };

  const handleReveal = () => {
    if (!fileManager) return;
    getTransport()
      .openIn(fileManager.id, dirPath)
      .catch((err: unknown) =>
        useToastStore
          .getState()
          .show({
            kind: "failed",
            title: "Couldn't open file manager",
            meta: String((err as { message?: string })?.message ?? err),
          }),
      );
  };

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
        {entries.length > 0 && (
          <>
            {entries.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                label={entry.label}
                icon={entry.icon}
                trailing={line !== undefined ? <span className="font-mono text-caption text-muted">:{line}</span> : undefined}
                onClick={() => handleOpenEditor(entry.id)}
              />
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem label="Reveal in file manager" icon={<FolderOpen />} onClick={handleReveal} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
