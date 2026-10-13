import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ApprovalSubject } from "@mcode/contracts";
import { areThemesAttached, getHighlighterIfLoaded, getHighlighterOptions, preloadHighlighter } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useShikiTheme, type ShikiTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

type ApprovalFilePatch = Extract<ApprovalSubject, { kind: "file_edit" }>["files"][number];

const APPROVAL_PATCH_PREVIEW_LINES = 3;

// Pierre renders inside a shadow root, so app tokens and the ligature rule only reach it as host variables.
const PATCH_UNSAFE_CSS = `
:host {
  background-color: transparent;
  --diffs-bg: transparent;
  --diffs-bg-context-override: transparent;
  --diffs-bg-addition-override: transparent;
  --diffs-bg-deletion-override: transparent;
  --diffs-bg-addition-number-override: transparent;
  --diffs-bg-deletion-number-override: transparent;
  --diffs-addition-color-override: var(--color-success);
  --diffs-deletion-color-override: var(--color-error);
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-font-features: "liga" 0, "calt" 0;
}
[data-line] { color: var(--color-muted); }
[data-line][data-line-type="change-addition"] { color: var(--color-success); }
[data-line][data-line-type="change-deletion"] { color: var(--color-error); }
`;

// Pierre pads the block by 8px, which would push the third row out of the 60px frame.
const PREVIEW_UNSAFE_CSS = `${PATCH_UNSAFE_CSS}
:host { --diffs-gap-block: 0px; }
`;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

function clipToPreviewRows(patch: string): { patch: string; truncated: boolean } {
  const lines = patch.split("\n");
  const hunkIndex = lines.findIndex((line) => HUNK_HEADER.test(line));
  const header = HUNK_HEADER.exec(lines[hunkIndex] ?? "");
  if (!header) return { patch, truncated: false };
  const bodyEnd = lines.findIndex((line, index) => index > hunkIndex && !/^[ +\-\\]/.test(line));
  const body = lines.slice(hunkIndex + 1, bodyEnd === -1 ? lines.length : bodyEnd);
  const rest = bodyEnd === -1 ? [] : lines.slice(bodyEnd);
  const rows = body.slice(0, APPROVAL_PATCH_PREVIEW_LINES);
  const oldCount = rows.filter((line) => line[0] === " " || line[0] === "-").length;
  const newCount = rows.filter((line) => line[0] === " " || line[0] === "+").length;
  return {
    patch: [...lines.slice(0, hunkIndex), `@@ -${header[1]},${oldCount} +${header[2]},${newCount} @@${header[3]}`, ...rows, ""].join("\n"),
    truncated: body.length > rows.length || rest.some((line) => line.length > 0),
  };
}

function isHighlighterReady(theme: ShikiTheme): boolean {
  return getHighlighterIfLoaded() != null && areThemesAttached(theme);
}

// StrictMode runs the ref twice on one node. With a cold highlighter the first pass leaves an empty <pre>,
// which the second pass hydrates as finished output, so nothing ever draws. A warm one renders synchronously.
function useHighlighterReady(theme: ShikiTheme): boolean {
  const [ready, setReady] = useState(() => isHighlighterReady(theme));
  useEffect(() => {
    if (ready) return;
    let mounted = true;
    void preloadHighlighter(getHighlighterOptions("text", { theme })).then(() => {
      if (mounted) setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, [ready, theme]);
  return ready;
}

function ApprovalPatchDiff({ patch, unsafeCSS }: { readonly patch: string; readonly unsafeCSS: string }) {
  const theme = useShikiTheme();
  const ready = useHighlighterReady(theme);
  const options = useMemo(() => ({
    theme,
    diffStyle: "unified",
    diffIndicators: "classic",
    lineDiffType: "none",
    overflow: "scroll",
    disableFileHeader: true,
    disableLineNumbers: true,
    hunkSeparators: "simple",
    // Lines take one colour per kind; syntax colours would compete with the add and remove signal.
    // Pierre renders any diff longer than this as plain text, so no grammar is loaded either.
    tokenizeMaxLength: 0,
    unsafeCSS,
  } as const), [theme, unsafeCSS]);
  return ready ? <PatchDiff patch={patch} options={options} disableWorkerPool /> : null;
}

function FullPatchDialog({ files, open, onOpenChange }: {
  readonly files: readonly ApprovalFilePatch[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  // The popup is portaled, but React still bubbles its keys to the dock, where a digit would answer the request.
  const keepKeysInDialog = (event: KeyboardEvent<HTMLDivElement>) => event.stopPropagation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] sm:max-w-3xl" onKeyDown={keepKeysInDialog}>
        <DialogHeader><DialogTitle>Proposed changes</DialogTitle></DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {files.map((file) => (
            <section key={file.path} aria-label={file.path} className="flex flex-col gap-1.5">
              <p className="font-code text-code-small text-ink text-fade">{file.path}</p>
              {file.patch
                ? <ApprovalPatchDiff patch={file.patch} unsafeCSS={PATCH_UNSAFE_CSS} />
                : <p className="text-xs text-muted">No diff available</p>}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The first file's diff clipped to {@link APPROVAL_PATCH_PREVIEW_LINES} lines. Lines never wrap: they
 * scroll sideways under a right-edge fade. Pending edits are not on disk yet, so Open diff shows every
 * file's full patch in a dialog rather than the review panel.
 */
export function ApprovalPatchPreview({ files }: { readonly files: readonly ApprovalFilePatch[] }) {
  const [open, setOpen] = useState(false);
  const firstPatch = files[0]?.patch;
  const preview = useMemo(() => (firstPatch ? clipToPreviewRows(firstPatch) : undefined), [firstPatch]);
  const hasMore = files.length > 1 || preview?.truncated === true;
  if (!preview && !hasMore) return null;
  return (
    <>
      <div className="relative">
        {preview && (
          <div data-testid="approval-patch-preview" className="h-[60px] w-full overflow-hidden mask-r-from-[calc(100%-var(--spacing-text-fade))]">
            <ApprovalPatchDiff patch={preview.patch} unsafeCSS={PREVIEW_UNSAFE_CSS} />
          </div>
        )}
        {hasMore && (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            className={cn("h-6 px-2 text-xs text-muted hover:text-ink", preview ? "absolute right-0 bottom-0 bg-hover" : "ml-auto flex")}
            onClick={() => setOpen(true)}
          >
            Open diff
          </Button>
        )}
      </div>
      <FullPatchDialog files={files} open={open} onOpenChange={setOpen} />
    </>
  );
}
