import { useCallback } from "react";
import { Eraser, MoreHorizontal, Search } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/button";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { dispatchTerminalClear } from "./terminalClear";
import { useFolderActions } from "./useFolderActions";
import { WorkingFolderPill } from "./WorkingFolderPill";

interface ShellControlsProps {
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly terminal: TerminalInstance;
  readonly onClose: (ptyId: string) => void;
}

function copyDiagnostics(): void {
  void getTransport()
    .terminalDiagnostics()
    .then((bundle) => navigator.clipboard.writeText(JSON.stringify(bundle)))
    .catch((error: unknown) => {
      useToastStore.getState().show({
        kind: "failed",
        title: "Couldn't copy diagnostics",
        meta: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Row 2 for the active shell: working folder, Search, Clear and More. */
export function ShellControls({ workspaceId, threadId, terminal, onClose }: ShellControlsProps) {
  const folder = useFolderActions(workspaceId, threadId, terminal.cwd ?? null);
  const search = useCallback(() => useTerminalStore.getState().openTerminalSearch(terminal.id), [terminal.id]);
  return (
    <PanelHeaderSlot slot="row2">
      <WorkingFolderPill
        path={folder.path}
        onOpenInEditor={folder.openInEditor}
        editorReason={folder.editorReason}
        onOpenInFileManager={folder.openInFileManager}
      />
      <IconButton shape="round" aria-label="Search terminal" onClick={search}>
        <Search />
      </IconButton>
      <IconButton shape="round" aria-label="Clear terminal" onClick={() => dispatchTerminalClear(terminal.id)}>
        <Eraser />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton shape="round" aria-label="More terminal actions">
              <MoreHorizontal />
            </IconButton>
          }
        />
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem label="Copy diagnostics" onClick={copyDiagnostics} />
          <DropdownMenuItem
            label="Open in external terminal"
            disabledReason={folder.externalTerminalReason}
            onClick={folder.openInExternalTerminal}
          />
          <DropdownMenuItem label="Close terminal" onClick={() => onClose(terminal.id)} />
        </DropdownMenuContent>
      </DropdownMenu>
    </PanelHeaderSlot>
  );
}
