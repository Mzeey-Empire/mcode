import { useRef, useState, type ReactNode } from "react";
import { FileRevertConfirm } from "./FileRevertConfirm";
import type { FileRevertSource } from "./file-revert-source";

export interface FileRevertActionProps {
  readonly onRevert?: () => void;
  readonly revertOpen: boolean;
}

export interface FileRevertInset {
  actionProps: (path: string) => FileRevertActionProps;
  inset: (path: string) => ReactNode;
}

/** Returns focus to the opener unless the user has already moved it somewhere else. */
function restoreFocus(opener: HTMLElement | null, confirm: HTMLElement | null): void {
  const active = document.activeElement;
  const focusLost = !active || active === document.body || confirm?.contains(active) === true;
  if (opener?.isConnected && focusLost) opener.focus();
}

/**
 * Tracks which file in a Review diff has its Revert file confirm open. The open
 * path is keyed by the comparison and the turns it reverts, so a view or turn
 * switch closes the confirm instead of carrying it to another comparison.
 */
export function useFileRevertInset(threadId: string, comparisonScope: string, revert: FileRevertSource | null | undefined): FileRevertInset {
  const [open, setOpen] = useState<{ readonly scope: string; readonly path: string } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  const scope = `${comparisonScope}:${revert?.messageId ?? ""}:${revert?.fromMessageId ?? ""}`;
  const openPath = revert && open?.scope === scope ? open.path : null;
  return {
    actionProps: (path) => ({
      onRevert: revert
        ? () => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setOpen(openPath === path ? null : { scope, path });
          }
        : undefined,
      revertOpen: openPath === path,
    }),
    inset: (path) =>
      revert && openPath === path ? (
        <div ref={confirmRef}>
          <FileRevertConfirm
            threadId={threadId}
            path={path}
            messageId={revert.messageId}
            fromMessageId={revert.fromMessageId}
            range={revert.range}
            onClose={() => {
              setOpen(null);
              restoreFocus(opener.current, confirmRef.current);
            }}
          />
        </div>
      ) : null,
  };
}
