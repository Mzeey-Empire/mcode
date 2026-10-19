import { ArrowUp, CornerDownRight, Paperclip, Pencil, X } from "lucide-react";
import { ProviderIdSchema } from "@mcode/contracts";
import { Button, IconButton } from "@/components/ui/button";
import {
  isSteerable,
  releaseHeldSteer,
  sendHeldSteerAgain,
} from "@/features/conversation/composer/queue/queued-steer";
import { useSendNowRoute } from "@/features/conversation/composer/queue/useQueuedMessageDispatch";
import { supportsTurnSteer } from "@/features/conversation/composer/composer-capabilities";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import { SentBrowserNotesTile } from "@/features/preview/notes/SentBrowserNotesTile";
import { isDeliveryUnknown, useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { useThreadStore } from "@/stores/threadStore";

const EMPTY_QUEUE: QueuedMessage[] = [];

interface ComposerQueueListProps {
  threadId: string;
  /** The thread's provider; Send now shows during a turn only if it accepts a steer. */
  provider?: string;
  /** True while another composer surface must finish before anything is sent. */
  isPaused?: boolean;
  /** Sends the message now: at once when idle, by steering while a turn runs. */
  onSendNow: (message: QueuedMessage) => void;
  /** Hands a queued message to the composer for editing; the parent pops it from the queue. */
  onLoadIntoComposer: (message: QueuedMessage) => void;
}

/**
 * Queued follow-ups as rows in the composer tray, in send order. Each row offers Send now,
 * Edit and Remove; a steer whose delivery is unknown offers Send again and Remove instead.
 */
export function ComposerQueueList({
  threadId,
  provider,
  isPaused = false,
  onSendNow,
  onLoadIntoComposer,
}: ComposerQueueListProps) {
  const queue = useQueueStore((s) => s.queues[threadId] ?? EMPTY_QUEUE);
  const providerId = ProviderIdSchema.safeParse(provider);
  const canSteer = useProviderAvailabilityStore((s) =>
    providerId.success && supportsTurnSteer(s.getAvailability(providerId.data)?.capabilities ?? []));
  const route = useSendNowRoute(threadId);
  const held = useQueueStore((s) => s.autoDrainSuppressedThreadIds.has(threadId));
  const idle = useThreadStore((s) => !s.runningThreadIds.has(threadId));
  if (queue.length === 0) return null;

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
      {held && idle ? <p className="text-caption text-muted">Paused</p> : null}
      <ul aria-label="Queued messages" className="m-0 list-none p-0">
        {queue.map((message, index) => (
          <li key={message.id} className="flex h-10 items-center gap-2">
            <span className="flex size-4 shrink-0 items-center justify-center">
              <CornerDownRight className="size-4 text-muted" aria-hidden />
            </span>
            <QueueRowText message={message} />
            {isDeliveryUnknown(message) ? (
              <DeliveryUnknownActions
                position={index + 1}
                onSendAgain={() => void sendHeldSteerAgain(threadId, message)}
                onRemove={() => void remove(message)}
              />
            ) : (
              <QueueRowActions
                position={index + 1}
                pending={pendingLabel(message)}
                canSendNow={canSendNow(message)}
                onSendNow={() => onSendNow(message)}
                onEdit={() => void edit(message)}
                onRemove={() => void remove(message)}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function QueueRowText({ message }: { message: QueuedMessage }) {
  const text = stripPreviewAnnotationFence(message.displayContent || message.content);
  const annotations = message.previewAnnotations;
  return (
    <>
        <span className="text-fade flex-1 text-body-small text-ink">
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
  readonly onSendNow: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

function QueueRowActions({ position, pending, canSendNow, onSendNow, onEdit, onRemove }: QueueRowActionsProps) {
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
      <IconButton aria-label={`Edit queued message ${position}`} tooltip="Edit" disabled={busy} onClick={onEdit}>
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
