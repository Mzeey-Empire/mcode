import { useCallback, useState } from "react";
import { Code2, FileText, ClipboardCopy, ExternalLink } from "lucide-react";
import { useToastStore } from "@/stores/toastStore";
import { FileEditorPicker } from "./FileEditorPicker";

/** Props for the SideRail component. */
interface SideRailProps {
  /** Path used as the clipboard payload (workspace-relative is fine). */
  readonly filePath: string;
  /**
   * Absolute path on disk. When provided, the Open action surfaces a picker
   * of installed editors plus Reveal. When undefined, Open is hidden — the
   * web-only context has no IPC for spawning editors.
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
  /** Whether the file is markdown — only then does the Preview toggle render. */
  readonly isMarkdown: boolean;
  /** Whether the rail is currently in preview mode. */
  readonly previewMode: boolean;
  /** Flip preview mode on or off. */
  readonly onTogglePreview: () => void;
}

/**
 * Vertical rail of file actions that overlays the right edge of an expanded
 * diff body. Hovering or keyboard-focusing the rail itself expands the
 * labels — the diff content is never the hover target, so the file's
 * disclosure button is never accidentally triggered when reaching for an
 * action.
 */
export function SideRail({
  filePath,
  absolutePath,
  absoluteDir,
  openAtLine,
  isMarkdown,
  previewMode,
  onTogglePreview,
}: SideRailProps) {
  // While the editor picker is open, focus moves into the portal-rendered
  // dropdown and the rail loses :focus-within / :hover. Tracking the open
  // state lets us force the rail expanded via a data attribute that mirrors
  // the same expand condition as hover/focus-within.
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleCopyPath = useCallback(() => {
    void navigator.clipboard
      .writeText(filePath)
      .then(() => useToastStore.getState().show("info", "Path copied"))
      .catch((err: unknown) =>
        useToastStore
          .getState()
          .show("error", "Couldn't copy path", String((err as { message?: string })?.message ?? err)),
      );
  }, [filePath]);

  return (
    <nav
      aria-label="File actions"
      data-picker-open={pickerOpen || undefined}
      className={[
        // Layout: absolutely positioned overlay anchored to the right edge.
        "group/rail absolute inset-y-0 right-0 z-[2]",
        "flex flex-col gap-0.5 overflow-hidden py-1.5",
        // Visual: subtle backdrop that lets the diff partially show through
        // when collapsed; opaque on expand.
        "w-8 border-l border-border/30 bg-background/75 backdrop-blur-[6px]",
        "transition-[width,background-color,box-shadow] duration-200",
        // The rail expands on any of three signals:
        //   1. Mouse hover anywhere on the nav
        //   2. Keyboard focus inside the nav
        //   3. data-picker-open=true — set by the FileEditorPicker while its
        //      popover is open. The popover is portal-rendered, so it lives
        //      outside the nav and would otherwise drop focus-within.
        "hover:w-[152px] hover:bg-background/95 hover:shadow-[-4px_0_16px_rgba(0,0,0,0.35)]",
        "focus-within:w-[152px] focus-within:bg-background/95 focus-within:shadow-[-4px_0_16px_rgba(0,0,0,0.35)]",
        "data-[picker-open]:w-[152px] data-[picker-open]:bg-background/95 data-[picker-open]:shadow-[-4px_0_16px_rgba(0,0,0,0.35)]",
      ].join(" ")}
    >
      <RailButton
        icon={<Code2 size={13} />}
        label="Diff"
        pressed={!previewMode}
        onClick={() => {
          if (previewMode) onTogglePreview();
        }}
        ariaLabel="Show raw diff"
      />

      {isMarkdown && (
        <RailButton
          icon={<FileText size={13} />}
          label="Preview"
          pressed={previewMode}
          onClick={() => {
            if (!previewMode) onTogglePreview();
          }}
          ariaLabel="Show rendered preview"
        />
      )}

      <RailSeparator />

      <RailButton
        icon={<ClipboardCopy size={13} />}
        label="Copy path"
        onClick={handleCopyPath}
        ariaLabel="Copy file path"
      />

      {absolutePath && (
        <FileEditorPicker
          filePath={absolutePath}
          dirPath={absoluteDir ?? absolutePath}
          line={openAtLine}
          onOpenChange={setPickerOpen}
          trigger={
            <button
              type="button"
              aria-label="Open file in editor"
              className={RAIL_BUTTON_CLASS}
            >
              <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                <ExternalLink size={13} />
              </span>
              <span className={RAIL_LABEL_CLASS}>Open</span>
            </button>
          }
        />
      )}
    </nav>
  );
}

/** Shared classes for the rail's button structure — used by both RailButton
 *  and the inline DropdownMenu trigger so they remain visually identical. */
const RAIL_BUTTON_CLASS = [
  "relative flex min-h-[30px] w-full items-center gap-2.5",
  "px-3 py-1 text-left font-mono text-[10.5px] uppercase tracking-[0.04em]",
  "transition-colors text-muted-foreground hover:bg-muted/50 hover:text-foreground",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring/55",
].join(" ");

const RAIL_LABEL_CLASS = [
  "-translate-x-1 whitespace-nowrap opacity-0",
  "transition-[opacity,transform] duration-150 delay-[60ms]",
  "group-hover/rail:translate-x-0 group-hover/rail:opacity-100",
  "group-focus-within/rail:translate-x-0 group-focus-within/rail:opacity-100",
  // Mirror hover/focus reveal when the picker popover is open — see the
  // nav-level data-picker-open notes above for why this is needed.
  "group-data-[picker-open]/rail:translate-x-0 group-data-[picker-open]/rail:opacity-100",
].join(" ");

/** Props for a single rail action button. */
interface RailButtonProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly ariaLabel: string;
}

/**
 * Single rail row: icon left, label fades in from the left when the rail
 * expands. `pressed` shows a thin accent indicator at the left edge.
 */
function RailButton({ icon, label, pressed, onClick, ariaLabel }: RailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      className={
        pressed
          ? `${RAIL_BUTTON_CLASS} bg-muted/40 text-foreground`
          : RAIL_BUTTON_CLASS
      }
    >
      {pressed && (
        <span
          aria-hidden
          className="absolute left-[3px] top-1/2 h-[14px] w-[2px] -translate-y-1/2 rounded-[2px] bg-primary"
        />
      )}
      <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className={RAIL_LABEL_CLASS}>{label}</span>
    </button>
  );
}

/**
 * Thin horizontal divider between rail action groups. Uses the full
 * `border` token (no opacity modifier) because the rail's semi-transparent
 * backdrop already dims everything beneath it — at /40 the line all but
 * vanished. Solid `bg-border` lands at roughly the same visual weight as
 * the panel's other dividers (`border-border/30` on opaque surfaces).
 */
function RailSeparator() {
  return <div aria-hidden className="mx-3 h-px bg-border" />;
}
