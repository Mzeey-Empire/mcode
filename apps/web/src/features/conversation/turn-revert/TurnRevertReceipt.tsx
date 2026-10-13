import { useCallback, useId, useState } from "react";
import { Undo } from "lucide-react";
import type { Message } from "@mcode/contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useThreadRecord } from "@/stores/thread-selectors";
import { useToastStore } from "@/stores/toastStore";
import { getTransport } from "@/transport";
import { failureCopy } from "./revert-copy";
import { acceptTurnRevert, sendUntilAnswered } from "./useTurnRevert";

/** System notice kinds that {@link TurnRevertReceipt} renders. */
export const TURN_REVERT_NOTICE_KINDS = new Set(["turn-reverted", "turn-revert-undone", "turn-revert-interrupted"]);

/**
 * The server writes "Reverted Turn 3 · 7 files" and "Undid revert · Turn 3".
 * The part after the first " · " is the mono detail of the receipt anatomy.
 */
function splitReceipt(content: string): { label: string; detail: string | null } {
  const at = content.indexOf(" · ");
  return at === -1 ? { label: content, detail: null } : { label: content.slice(0, at), detail: content.slice(at + 3) };
}

/**
 * A revert stays undoable until an undo receipt names it. Receipts persist,
 * so this survives a reload; the server still answers `recovery_expired`
 * when the revert's safety material is gone.
 */
function useIsUndone(threadId: string, revertId: string | undefined): boolean {
  return useThreadRecord(threadId, (record) =>
    revertId !== undefined && record.messages.some((message) => message.systemNotice?.undoesRevertId === revertId));
}

type UndoState = { readonly pending: boolean; readonly disabledReason: string | null };

/** Undo for one committed revert, with a `requestId` per click that is resent after a reconnect. */
function useUndoRevert(threadId: string, revertId: string | undefined) {
  const [state, setState] = useState<UndoState>({ pending: false, disabledReason: null });
  const undo = useCallback(() => {
    if (!revertId) return;
    setState({ pending: true, disabledReason: null });
    const requestId = crypto.randomUUID();
    sendUntilAnswered(() => getTransport().undoTurnRevert(threadId, revertId, requestId)).then(
      (result) => {
        if (result.status === "reverted") {
          acceptTurnRevert({ threadId, receipt: result.receipt });
          setState({ pending: false, disabledReason: null });
          return;
        }
        if (result.status === "stale") {
          setState({ pending: false, disabledReason: "Files changed since the revert" });
          return;
        }
        const { text, retry } = failureCopy(result);
        setState({ pending: false, disabledReason: retry || result.status === "busy" ? null : text });
        if (retry || result.status === "busy") useToastStore.getState().show({ kind: "failed", title: "Couldn't undo the revert", meta: text });
      },
      (error: unknown) => {
        setState({ pending: false, disabledReason: null });
        useToastStore.getState().show({ kind: "failed", title: "Couldn't undo the revert", meta: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [threadId, revertId]);
  return { ...state, undo };
}

/** Paper receipt row (`2799-2`) for a turn revert, its undo, or an interrupted revert. */
export function TurnRevertReceipt({ message }: { readonly message: Message }) {
  const notice = message.systemNotice;
  const revertId = notice?.revertId;
  const undone = useIsUndone(message.thread_id, revertId);
  const { pending, disabledReason, undo } = useUndoRevert(message.thread_id, revertId);
  const { label, detail } = splitReceipt(message.content);
  const undoable = notice?.kind === "turn-reverted" && revertId !== undefined && !undone;

  return (
    <div className="flex h-7 min-w-0 max-w-full items-center gap-2 px-2" role="note" data-turn-revert-receipt={revertId}>
      <Undo aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
      <span className={cn("min-w-0 text-fade whitespace-nowrap text-sm leading-5 text-muted", detail && "max-w-[60%] shrink-0")}>
        {label}
      </span>
      {detail && <span className="min-w-0 text-fade whitespace-nowrap font-mono text-xs leading-5 text-muted">{detail}</span>}
      {undoable && <UndoButton pending={pending} disabledReason={disabledReason} onUndo={undo} />}
    </div>
  );
}

const UNDO_CLASS =
  "shrink-0 rounded-sm text-label text-muted outline-none transition-colors hover:text-ink focus-visible:ring-1 focus-visible:ring-focus aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:text-muted";

function UndoButton({ pending, disabledReason, onUndo }: { readonly pending: boolean; readonly disabledReason: string | null; readonly onUndo: () => void }) {
  const reasonId = useId();
  if (disabledReason) {
    // aria-disabled rather than disabled keeps the button focusable, so keyboard users reach the reason.
    return (
      <>
        <Tooltip>
          <TooltipTrigger render={<button type="button" aria-disabled="true" aria-describedby={reasonId} className={UNDO_CLASS}>Undo</button>} />
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
        <span id={reasonId} hidden>{disabledReason}</span>
      </>
    );
  }
  return (
    <button type="button" aria-busy={pending || undefined} disabled={pending} onClick={onUndo} className={cn(UNDO_CLASS, "disabled:opacity-50")}>
      Undo
    </button>
  );
}
