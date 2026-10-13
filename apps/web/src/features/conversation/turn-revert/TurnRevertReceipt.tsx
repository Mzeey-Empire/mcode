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

function splitReceipt(content: string): { label: string; detail: string | null } {
  const at = content.indexOf(" · ");
  return at === -1 ? { label: content, detail: null } : { label: content.slice(0, at), detail: content.slice(at + 3) };
}

function useIsUndone(threadId: string, revertId: string | undefined): boolean {
  return useThreadRecord(threadId, (record) =>
    revertId !== undefined && record.messages.some((message) => message.systemNotice?.kind === "turn-revert-undone" && message.systemNotice.undoesRevertId === revertId));
}

type UndoState = { readonly pending: boolean; readonly done: boolean; readonly disabledReason: string | null };

function useUndoRevert(threadId: string, revertId: string | undefined) {
  const [state, setState] = useState<UndoState>({ pending: false, done: false, disabledReason: null });
  const undo = useCallback(() => {
    if (!revertId) return;
    setState({ pending: true, done: false, disabledReason: null });
    const requestId = crypto.randomUUID();
    sendUntilAnswered(() => getTransport().undoTurnRevert(threadId, revertId, requestId)).then(
      (result) => {
        if (result.status === "reverted") {
          acceptTurnRevert({ threadId, receipt: result.receipt });
          // A paged-back timeline skips the appended receipt, so the store alone can't say this revert is undone.
          setState({ pending: false, done: true, disabledReason: null });
          return;
        }
        if (result.status === "stale") {
          setState({ pending: false, done: false, disabledReason: "Files changed since the revert" });
          return;
        }
        const { text, retry } = failureCopy(result);
        setState({ pending: false, done: false, disabledReason: retry || result.status === "busy" ? null : text });
        if (retry || result.status === "busy") useToastStore.getState().show({ kind: "failed", title: "Couldn't undo the revert", meta: text });
      },
      (error: unknown) => {
        setState({ pending: false, done: false, disabledReason: null });
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
  const { pending, done, disabledReason, undo } = useUndoRevert(message.thread_id, revertId);
  const { label, detail } = splitReceipt(message.content);
  const undoable = notice?.kind === "turn-reverted" && revertId !== undefined && !undone && !done;

  return (
    <div className="flex h-7 min-w-0 max-w-full items-center gap-2 px-2" role="note" data-turn-revert-receipt={revertId}>
      <Undo aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-muted" />
      <span className={cn("min-w-0 text-fade whitespace-nowrap text-sm leading-5 text-muted", detail && "max-w-[60%] shrink-0")}>
        {label}
      </span>
      {detail && <span aria-hidden className="shrink-0 text-sm leading-5 text-muted">·</span>}
      {detail && <span className="min-w-0 text-fade whitespace-nowrap font-mono text-xs leading-5 text-muted">{detail}</span>}
      {undoable && <UndoButton pending={pending} disabledReason={disabledReason} onUndo={undo} />}
    </div>
  );
}

const UNDO_CLASS =
  "shrink-0 rounded-sm text-label text-muted outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:text-muted";

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
    <button
      type="button"
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      onClick={pending ? undefined : onUndo}
      className={cn(UNDO_CLASS, "aria-busy:cursor-progress")}
    >
      Undo
    </button>
  );
}
