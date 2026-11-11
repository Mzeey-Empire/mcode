import { Fragment } from "react";
import { ArrowUp, CornerDownRight, FileText, Paperclip, Pencil, X } from "lucide-react";
import { ProviderIdSchema } from "@mcode/contracts/models/settings";
import { Button, IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  isSteerable,
  releaseHeldSteer,
  sendHeldSteerAgain,
} from "@/features/conversation/composer/queue/queued-steer";
import { useQueuedMessageDispatch, useSendNowRoute } from "@/features/conversation/composer/queue/useQueuedMessageDispatch";
import { supportsTurnSteer } from "@/features/conversation/composer/composer-capabilities";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import { SentBrowserNotesTile } from "@/features/preview/notes/SentBrowserNotesTile";
import { isDeliveryUnknown, useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";

const EMPTY_QUEUE: QueuedMessage[] = [];

interface ComposerQueueListProps {
  threadId: string;
  /** The thread's provider; Send now shows during a turn only if it accepts a steer. */
  provider?: string;
  /** True while another composer surface must finish before anything is sent. */
  isPaused?: boolean;
  /** True while a dock hides the composer input, so Edit would move a row out of sight. */
  isEditLocked?: boolean;
  /** Sends the message now: at once when idle, by steering while a turn runs. */
  onSendNow: (message: QueuedMessage) => void;
  /** Hands a queued message to the composer for editing; the parent pops it from the queue. */
  onLoadIntoComposer: (message: QueuedMessage) => void;
  /**
   * The queued message open in the composer, or null: where it goes back on save, and the unsent draft set aside
   * behind the queue meanwhile, which returns to the composer and never sends.
   */
  editing?: { readonly originalIndex: number; readonly parkedDraftId: string | null } | null;
}

/**
 * Queued follow-ups as rows in the composer tray, in send order. Each row offers Send now,
 * Edit and Remove; a steer whose delivery is unknown offers Send again and Remove instead.
 */
export function ComposerQueueList({
  threadId,
  provider,
  isPaused = false,
  isEditLocked = false,
  onSendNow,
  onLoadIntoComposer,
  editing = null,
}: ComposerQueueListProps) {
  const queue = useQueueStore((s) => s.queues[threadId] ?? EMPTY_QUEUE);
  const providerId = ProviderIdSchema.safeParse(provider);
  const canSteer = useProviderAvailabilityStore((s) =>
    providerId.success && supportsTurnSteer(s.getAvailability(providerId.data)?.capabilities ?? []));
  const route = useSendNowRoute(threadId);
  const held = useQueueStore((s) => s.autoDrainSuppressedThreadIds.has(threadId));
  const pauseReason = useQueueStore((s) => s.autoDrainPauseReasons[threadId]);
  const { resume } = useQueuedMessageDispatch(threadId);
  if (queue.length === 0 && editing === null) return null;
  const { slot, position, parkedDraftId } = editingSlot(editing, queue.length);

  const canSendNow = (message: QueuedMessage) => !isPaused
    && (route === "send" || (route === "steer" && canSteer && isSteerable(message)));

  const edit = async (message: QueuedMessage) => {
    if (await releaseHeldSteer(threadId, message) === "plain") onLoadIntoComposer(message);
  };
  const remove = async (message: QueuedMessage) => {
    if (await releaseHeldSteer(threadId, message) === "plain") useQueueStore.getState().removeFromQueue(threadId, message.id);
  };

  return (
    <>
      {held ? (
        <div className="flex items-center justify-between gap-2 text-caption text-muted">
          <p><span>Paused</span>{pauseReason ? <> · <span>{pauseReason}</span></> : null}</p>
          <Button variant="ghost" aria-label="Resume queued messages" disabled={isPaused || route !== "send"} onClick={resume}>
            Resume
          </Button>
        </div>
      ) : null}
      <ul aria-label="Queued messages" className="m-0 list-none p-0">
        {slot === 0 ? <EditingSlotRow /> : null}
        {queue.map((message, index) => (
          <Fragment key={message.id}>
            <li className="flex h-10 items-center gap-2">
              <QueueRowGlyph parked={message.id === parkedDraftId} />
              <QueueRowText message={message} parked={message.id === parkedDraftId} />
              {isDeliveryUnknown(message) ? (
                <DeliveryUnknownActions
                  position={position(index)}
                  onSendAgain={() => void sendHeldSteerAgain(threadId, message)}
                  onRemove={() => void remove(message)}
                />
              ) : (
                <QueueRowActions
                  position={position(index)}
                  pending={pendingLabel(message)}
                  canSendNow={canSendNow(message)}
                  editLocked={isEditLocked}
                  onSendNow={() => onSendNow(message)}
                  onEdit={() => void edit(message)}
                  onRemove={() => void remove(message)}
                />
              )}
            </li>
            {slot === index + 1 ? <EditingSlotRow /> : null}
          </Fragment>
        ))}
      </ul>
    </>
  );
}

/**
 * The edited message keeps its slot, so the tray shows which message the composer is editing, and the rows after it
 * show the positions they will have once it is saved.
 */
function editingSlot(editing: ComposerQueueListProps["editing"], length: number) {
  const slot = editing ? Math.min(editing.originalIndex, length) : null;
  return {
    slot,
    position: (index: number) => (slot !== null && index >= slot ? index + 2 : index + 1),
    parkedDraftId: editing ? editing.parkedDraftId : null,
  };
}

/** Holds the place of the queued message open in the composer. */
function EditingSlotRow() {
  return (
    <li className="flex h-10 items-center gap-2 text-body-small text-muted">
      <span className="flex size-4 shrink-0 items-center justify-center">
        <Pencil className="size-4" aria-hidden />
      </span>
      Editing
    </li>
  );
}

/** A queued message leads with the send-next arrow; the set-aside draft, which never sends, with a page. */
function QueueRowGlyph({ parked }: { readonly parked: boolean }) {
  const Glyph = parked ? FileText : CornerDownRight;
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <Glyph className="size-4 text-muted" aria-hidden />
    </span>
  );
}

function QueueRowText({ message, parked }: { message: QueuedMessage; parked: boolean }) {
  const text = stripPreviewAnnotationFence(message.displayContent || message.content);
  const annotations = message.previewAnnotations;
  return (
    <>
        <span className={cn("text-fade flex-1 text-body-small", parked ? "text-muted" : "text-ink")}>
          {parked ? <span className="sr-only">Unsent draft, back in the composer after the edit: </span> : null}
          {text || <span className="sr-only">Preview annotation</span>}
        </span>
        {annotations && annotations.annotations.length > 0 ? (
          <SentBrowserNotesTile bundle={annotations} variant="row" />
        ) : null}
        {message.attachments.length > 0 ? (
          <span
            className="flex shrink-0 items-center gap-0.5 text-body-small tabular-nums text-muted"
            aria-label={`${message.attachments.length} ${message.attachments.length === 1 ? "attachment" : "attachments"}`}
          >
            <Paperclip className="size-4" aria-hidden />
            {message.attachments.length}
          </span>
        ) : null}
    </>
  );
}

/** What a row is waiting on, if anything; nothing may change the item until it answers. */
function pendingLabel(message: QueuedMessage): string | undefined {
  if (message.steer?.state === "steering") return "Adding to turn";
  if (message.steer?.state === "settling") return "Settling";
  return undefined;
}

interface QueueRowActionsProps {
  readonly position: number;
  readonly pending: string | undefined;
  readonly canSendNow: boolean;
  readonly editLocked: boolean;
  readonly onSendNow: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

function QueueRowActions({ position, pending, canSendNow, editLocked, onSendNow, onEdit, onRemove }: QueueRowActionsProps) {
  const busy = pending !== undefined;
  return (
    <span className="flex shrink-0 items-center justify-end gap-1">
      <span role="status" className="text-body-small text-muted">{pending}</span>
      <span className="flex w-24 items-center justify-end">
      {canSendNow && !busy ? (
        <IconButton aria-label={`Send queued message ${position} now`} tooltip="Send now" onClick={onSendNow}>
          <ArrowUp />
        </IconButton>
      ) : null}
      <IconButton aria-label={`Edit queued message ${position}`} tooltip="Edit" disabled={busy || editLocked} onClick={onEdit}>
        <Pencil />
      </IconButton>
      <IconButton aria-label={`Remove queued message ${position}`} tooltip="Remove" disabled={busy} onClick={onRemove}>
        <X />
      </IconButton>
      </span>
    </span>
  );
}

function DeliveryUnknownActions({ position, onSendAgain, onRemove }: {
  position: number;
  onSendAgain: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="text-body-small text-muted">Delivery unknown</span>
      <Button variant="ghost" aria-label={`Send queued message ${position} again`} onClick={onSendAgain}>
        Send again
      </Button>
      <Button variant="ghost" aria-label={`Remove queued message ${position}`} onClick={onRemove}>Remove</Button>
    </span>
  );
}
