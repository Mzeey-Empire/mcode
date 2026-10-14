import { useCallback, useMemo } from "react";
import type { TurnRevertPreview } from "@mcode/contracts";
import { RevertConfirm } from "@/features/conversation/turn-revert/RevertConfirm";
import { fileRevertBody, fileRevertTitle, type FileRevertRange } from "@/features/conversation/turn-revert/revert-copy";
import { useTurnRevert } from "@/features/conversation/turn-revert/useTurnRevert";

type ReadyPreview = Extract<TurnRevertPreview, { status: "ready" }>;

/** Props for {@link FileRevertConfirm}. */
export interface FileRevertConfirmProps {
  readonly threadId: string;
  /** Workspace-relative path of the file header the inset sits under. */
  readonly path: string;
  /** Server id of the last turn in the range. */
  readonly messageId: string;
  /** Server id of the first turn of a multi-turn range. Omit for a single turn. */
  readonly fromMessageId?: string;
  readonly range: FileRevertRange;
  readonly onClose: () => void;
}

/**
 * The Revert file confirm, an inset under a Review file header. It scopes S08's
 * confirm to one file over one turn or a range of turns, and closes on success
 * or Cancel.
 */
export function FileRevertConfirm({ threadId, path, messageId, fromMessageId, range, onClose }: FileRevertConfirmProps) {
  const target = useMemo(
    () => ({ threadId, messageId, scope: { kind: "file" as const, path, ...(fromMessageId ? { fromMessageId } : {}) } }),
    [threadId, messageId, path, fromMessageId],
  );
  const { state, apply } = useTurnRevert(target, onClose);
  const title = useCallback(() => fileRevertTitle(path, range), [path, range]);
  const body = useCallback((preview: ReadyPreview) => fileRevertBody(preview, path, range), [path, range]);
  return <RevertConfirm state={state} title={title} body={body} onRevert={apply} onCancel={onClose} />;
}
