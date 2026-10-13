import { useCallback } from "react";
import { CodeXml, FileText, ClipboardCopy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores/toastStore";
import { FileEditorPicker } from "./FileEditorPicker";

/** Props for the FileActionBar component. */
interface FileActionBarProps {
  /**
   * Workspace-relative path. Used as a clipboard fallback only — Copy
   * prefers `absolutePath` when available so the pasted value works in
   * terminals and external tools without further resolution.
   */
  readonly filePath: string;
  /**
   * Absolute path on disk. Used as the Copy payload and by the Open
   * action's editor picker / Reveal. Resolved upstream from the workspace
   * or worktree root plus the relative `filePath`, so in practice this is
   * always populated — undefined only during transient pre-hydration.
   */
  readonly absolutePath?: string;
  /**
   * Absolute parent directory of the file. Used by the picker's Reveal
   * action to open the OS file manager. Falls back to `absolutePath` if
   * omitted, which is harmless — most OS file managers handle either.
   */
  readonly absoluteDir?: string;
  /** Line to jump to when opening in an editor (first hunk's new-start line). */
  readonly openAtLine?: number;
  /** Whether the file is markdown — only then does the Diff/Preview toggle render. */
  readonly isMarkdown: boolean;
  /** Whether the body is currently in preview mode. */
  readonly previewMode: boolean;
  /** Flip preview mode on or off. */
  readonly onTogglePreview: () => void;
}

/** 24px icon button shared by every action, per Paper 10a. Muted at rest, ink on hover. */
const ACTION_BUTTON_CLASS = [
  "size-6 shrink-0 rounded-sm p-0 text-muted",
  "transition-colors hover:bg-ink/10 hover:text-ink",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus/55",
].join(" ");

/** Active segment of the Diff/Preview toggle. */
const ACTION_BUTTON_ACTIVE = "bg-selected text-ink";

/**
 * Per-file actions in the Review file header: a Diff/Preview toggle (markdown
 * only), Copy path, and Open in editor.
 */
export function FileActionBar({
  filePath,
  absolutePath,
  absoluteDir,
  openAtLine,
  isMarkdown,
  previewMode,
  onTogglePreview,
}: FileActionBarProps) {
  const handleCopyPath = useCallback(() => {
    // Prefer the absolute on-disk path so the clipboard value is immediately
    // usable in terminals / external editors without the recipient needing to
    // know the workspace root. Relative is only a fallback for the (unreachable
    // in normal flows) state where the workspace base hasn't hydrated yet.
    const payload = absolutePath ?? filePath;
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      useToastStore
        .getState()
        .show({
          kind: "failed",
          title: "Couldn't copy path",
          meta: "Clipboard API is unavailable in this environment.",
        });
      return;
    }
    void clipboard
      .writeText(payload)
      .then(() => useToastStore.getState().show({
        kind: "info",
        title: "Path copied",
      }))
      .catch((err: unknown) =>
        useToastStore
          .getState()
          .show({
            kind: "failed",
            title: "Couldn't copy path",
            meta: String((err as { message?: string })?.message ?? err),
          }),
      );
  }, [absolutePath, filePath]);

  return (
    <div role="group" aria-label="File actions" className="flex shrink-0 items-center gap-0.5 pl-1">
      {isMarkdown && (
        <>
          <Button
            type="button"
            variant="ghost"
            aria-label="Show raw diff"
            aria-pressed={!previewMode}
            onClick={() => {
              if (previewMode) onTogglePreview();
            }}
            className={cn(ACTION_BUTTON_CLASS, !previewMode && ACTION_BUTTON_ACTIVE)}
          >
            <CodeXml size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="Show rendered preview"
            aria-pressed={previewMode}
            onClick={() => {
              if (!previewMode) onTogglePreview();
            }}
            className={cn(ACTION_BUTTON_CLASS, previewMode && ACTION_BUTTON_ACTIVE)}
          >
            <FileText size={14} />
          </Button>
        </>
      )}

      <Button
        type="button"
        variant="ghost"
        aria-label="Copy file path"
        onClick={handleCopyPath}
        className={ACTION_BUTTON_CLASS}
      >
        <ClipboardCopy size={14} />
      </Button>

      {absolutePath && (
        <FileEditorPicker
          filePath={absolutePath}
          dirPath={absoluteDir ?? absolutePath}
          line={openAtLine}
          trigger={
            <Button
              type="button"
              variant="ghost"
              aria-label="Open file in editor"
              className={ACTION_BUTTON_CLASS}
            >
              <ExternalLink size={14} />
            </Button>
          }
        />
      )}
    </div>
  );
}
