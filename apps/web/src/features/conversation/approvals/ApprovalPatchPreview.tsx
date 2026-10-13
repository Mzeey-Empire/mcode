import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ApprovalSubject } from "@mcode/contracts";
import { PatchDiff } from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useShikiTheme } from "@/hooks/useTheme";

type ApprovalFilePatch = Extract<ApprovalSubject, { kind: "file_edit" }>["files"][number];

/** The dock shows this many diff lines; anything longer needs Open diff to be read. */
export const APPROVAL_PATCH_PREVIEW_LINES = 3;

// Pierre renders inside a shadow root, so app tokens and the ligature rule only reach it as host variables.
const PATCH_UNSAFE_CSS = `
:host {
  --diffs-bg: transparent;
  --diffs-bg-addition-override: transparent;
  --diffs-bg-deletion-override: transparent;
  --diffs-addition-color-override: var(--color-success);
  --diffs-deletion-color-override: var(--color-error);
  --diffs-font-family: var(--font-mono);
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-font-features: "liga" 0, "calt" 0;
}
`;

function patchBodyLineCount(patch: string): number {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunk === -1) return 0;
  return lines.slice(firstHunk).filter((line) => /^[ +-]/.test(line)).length;
}

function usePatchOptions(): FileDiffOptions<undefined, undefined> {
  const theme = useShikiTheme();
  return useMemo(() => ({
    theme,
    diffStyle: "unified",
    diffIndicators: "classic",
    overflow: "scroll",
    disableFileHeader: true,
    disableLineNumbers: true,
    hunkSeparators: "simple",
    unsafeCSS: PATCH_UNSAFE_CSS,
  }), [theme]);
}

function FullPatchDialog({ files, open, onOpenChange }: {
  readonly files: readonly ApprovalFilePatch[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const options = usePatchOptions();
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
                ? <PatchDiff patch={file.patch} options={options} disableWorkerPool />
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
  const options = usePatchOptions();
  const [open, setOpen] = useState(false);
  const patch = files[0]?.patch;
  if (!patch) return null;
  const hasMore = files.length > 1 || patchBodyLineCount(patch) > APPROVAL_PATCH_PREVIEW_LINES;
  return (
    <>
      <div data-testid="approval-patch-preview" className="h-[60px] w-full overflow-hidden mask-r-from-[calc(100%-var(--spacing-text-fade))]">
        <PatchDiff patch={patch} options={options} disableWorkerPool />
      </div>
      {hasMore && (
        <Button type="button" variant="link" size="compact" className="h-auto self-end px-0 text-xs" onClick={() => setOpen(true)}>
          Open diff
        </Button>
      )}
      <FullPatchDialog files={files} open={open} onOpenChange={setOpen} />
    </>
  );
}
