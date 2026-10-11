import { ArrowUp, CornerDownRight, Paperclip, Pencil, X } from "lucide-react";
import { ProviderIdSchema } from "@mcode/contracts";
import { Button, IconButton } from "@/components/ui/button";
import {
  heldSteerId,
  isSteerable,
  removeHeldSteer,
  sendHeldSteerAgain,
} from "@/features/conversation/composer/queue/queued-steer";
import { supportsTurnSteer } from "@/features/conversation/composer/composer-capabilities";
import { stripPreviewAnnotationFence } from "@/features/preview/capture/preview-annotation-append";
import { isDeliveryUnknown, useQueueStore, type QueuedMessage } from "@/stores/queueStore";
import { useProviderAvailabilityStore } from "@/stores/providerAvailabilityStore";
import { PreviewAnnotationBundleChip } from "./PreviewAnnotationBundleChip";

const EMPTY_QUEUE: QueuedMessage[] = [];

interface ComposerQueueListProps {
  threadId: string;
  isAgentRunning: boolean;
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
  isAgentRunning,
  provider,
  isPaused = false,
  onSendNow,
  onLoadIntoComposer,
}: ComposerQueueListProps) {
  const queue = useQueueStore((s) => s.queues[threadId] ?? EMPTY_QUEUE);
  const providerId = ProviderIdSchema.safeParse(provider);
  const canSteer = useProviderAvailabilityStore((s) =>
    providerId.success && supportsTurnSteer(s.getAvailability(providerId.data)?.capabilities ?? []));
  if (queue.length === 0) return null;

  const canSendNow = (message: QueuedMessage) =>
    !isPaused && (!isAgentRunning || (canSteer && isSteerable(message)));

  // A resend is held by the server, so Edit and Remove settle it there first.
  const releaseHeld = async (message: QueuedMessage): Promise<boolean> => {
    const steerId = heldSteerId(message);
    if (!steerId) return true;
    if (!(await removeHeldSteer(steerId))) return false;
    useQueueStore.getState().setQueuedSteer(threadId, message.id, undefined);
    return true;
  };
  const edit = async (message: QueuedMessage) => {
    if (await releaseHeld(message)) onLoadIntoComposer(message);
  };
  const remove = async (message: QueuedMessage) => {
    if (await releaseHeld(message)) useQueueStore.getState().removeFromQueue(threadId, message.id);
  };

  return (
    <ul aria-label="Queued messages" className="m-0 list-none p-0">
      {queue.map((message, index) => (
        <li key={message.id} className="flex h-10 items-center gap-2">
          <span className="flex size-4 shrink-0 items-center justify-center">
            <CornerDownRight className="size-4 text-muted" strokeWidth={1.5} aria-hidden />
          </span>
          <QueueRowText message={message} />
          {isDeliveryUnknown(message) ? (
            <DeliveryUnknownActions threadId={threadId} message={message} onRemove={() => void remove(message)} />
          ) : (
            <QueueRowActions
              position={index + 1}
              steering={message.steer?.state === "steering"}
              canSendNow={canSendNow(message)}
              onSendNow={() => onSendNow(message)}
              onEdit={() => void edit(message)}
              onRemove={() => void remove(message)}
            />
          )}
        </li>
      ))}
    </ul>
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
        <PreviewAnnotationBundleChip
          bundle={annotations}
          testId="queue-annotation-bundle"
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs"
        />
      ) : null}
      {message.attachments.length > 0 ? (
        <span
          className="flex shrink-0 items-center gap-0.5 text-body-small tabular-nums text-muted"
          aria-label={`${message.attachments.length} ${message.attachments.length === 1 ? "attachment" : "attachments"}`}
        >
          <Paperclip className="size-4" strokeWidth={1.5} aria-hidden />
          {message.attachments.length}
        </span>
      ) : null}
    </>
  );
}

interface QueueRowActionsProps {
  readonly position: number;
  /** A steer is awaiting its answer; nothing may change the item until it arrives. */
  readonly steering: boolean;
  readonly canSendNow: boolean;
  readonly onSendNow: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

function QueueRowActions({ position, steering, canSendNow, onSendNow, onEdit, onRemove }: QueueRowActionsProps) {
  return (
    <span className="flex w-24 shrink-0 items-center justify-end">
      {canSendNow && !steering ? (
        <IconButton aria-label={`Send queued message ${position} now`} tooltip="Send now" onClick={onSendNow}>
          <ArrowUp strokeWidth={1.5} />
        </IconButton>
      ) : null}
      <IconButton aria-label={`Edit queued message ${position}`} tooltip="Edit" disabled={steering} onClick={onEdit}>
        <Pencil strokeWidth={1.5} />
      </IconButton>
      <IconButton aria-label={`Remove queued message ${position}`} tooltip="Remove" disabled={steering} onClick={onRemove}>
        <X strokeWidth={1.5} />
      </IconButton>
    </span>
  );
}

function DeliveryUnknownActions({ threadId, message, onRemove }: {
  threadId: string;
  message: QueuedMessage;
  onRemove: () => void;
}) {
  const steerId = heldSteerId(message);
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span className="text-body-small text-muted">Delivery unknown</span>
      <Button variant="ghost" onClick={() => { if (steerId) void sendHeldSteerAgain(threadId, steerId); }}>
        Send again
      </Button>
      <Button variant="ghost" onClick={onRemove}>Remove</Button>
    </span>
  );
}
