import { useCallback } from "react";
import { Code2, FileText, ClipboardCopy } from "lucide-react";
import { useToastStore } from "@/stores/toastStore";

/** Props for the SideRail component. */
interface SideRailProps {
  /** Path used as the clipboard payload (workspace-relative is fine). */
  readonly filePath: string;
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
export function SideRail({ filePath, isMarkdown, previewMode, onTogglePreview }: SideRailProps) {
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
      className={[
        // Layout: absolutely positioned overlay anchored to the right edge.
        "group/rail absolute inset-y-0 right-0 z-[2]",
        "flex flex-col gap-0.5 overflow-hidden py-1.5",
        // Visual: subtle backdrop that lets the diff partially show through
        // when collapsed; opaque on expand.
        "w-8 border-l border-border/30 bg-background/75 backdrop-blur-[6px]",
        "transition-[width,background-color,box-shadow] duration-200",
        "hover:w-[152px] hover:bg-background/95 hover:shadow-[-4px_0_16px_rgba(0,0,0,0.35)]",
        "focus-within:w-[152px] focus-within:bg-background/95 focus-within:shadow-[-4px_0_16px_rgba(0,0,0,0.35)]",
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
    </nav>
  );
}

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
      className={[
        "relative flex min-h-[30px] w-full items-center gap-2.5",
        "px-3 py-1 text-left font-mono text-[10.5px] uppercase tracking-[0.04em]",
        "transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring/55",
        pressed
          ? "bg-muted/40 text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      ].join(" ")}
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
      <span
        className={[
          "-translate-x-1 whitespace-nowrap opacity-0",
          "transition-[opacity,transform] duration-150 delay-[60ms]",
          "group-hover/rail:translate-x-0 group-hover/rail:opacity-100",
          "group-focus-within/rail:translate-x-0 group-focus-within/rail:opacity-100",
        ].join(" ")}
      >
        {label}
      </span>
    </button>
  );
}

/** Thin horizontal divider between rail action groups. */
function RailSeparator() {
  return <div aria-hidden className="mx-3 h-px bg-border/40" />;
}
