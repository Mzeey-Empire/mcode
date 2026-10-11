import type { HeldSteer, TurnSteerResult } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useQueueStore, type QueuedMessage, type QueuedSteer } from "@/stores/queueStore";
import { useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport, RpcError } from "@/transport";

type SteeringSteer = Extract<QueuedSteer, { state: "steering" }>;

/**
 * A steer carries only text and mentions, so a message with attachments, preview
 * annotations or a browser capture would lose them; those wait for the next turn instead.
 */
export function isSteerable(message: QueuedMessage): boolean {
  return !message.steer
    && message.attachments.length === 0
    && !message.previewAnnotations
    && !message.browserCaptureSpillPaths?.length;
}

function findQueued(threadId: string, predicate: (message: QueuedMessage) => boolean): QueuedMessage | undefined {
  return (useQueueStore.getState().queues[threadId] ?? []).find(predicate);
}

function applySteerResult(threadId: string, itemId: string, steerId: string, result: TurnSteerResult): void {
  const queue = useQueueStore.getState();
  if (result.status === "delivery_unknown") {
    queue.setQueuedSteer(threadId, itemId, { state: "delivery_unknown", steerId });
    return;
  }
  queue.removeFromQueue(threadId, itemId);
}

async function callSteer(threadId: string, message: QueuedMessage, steer: SteeringSteer): Promise<void> {
  try {
    const result = await getTransport().steerTurn({
      threadId,
      turnExecutionId: steer.turnExecutionId,
      messageId: steer.steerId,
      content: message.content,
      ...(message.mentions?.length ? { mentions: message.mentions } : {}),
    });
    applySteerResult(threadId, message.id, steer.steerId, result);
  } catch (error) {
    // Without an answer the provider may hold the message, so it keeps its steer id and the
    // reconnect replay asks again. An RPC error is an answer: the provider never took it.
    if (!(error instanceof RpcError)) return;
    useQueueStore.getState().setQueuedSteer(threadId, message.id, undefined);
    const detail = typeof error.data?.detail === "string" ? error.data.detail : error.message;
    useToastStore.getState().show({ kind: "failed", title: "Not added to the running turn", meta: detail });
  }
}

/** Steers one queued message into the running turn under a fresh steer id. */
export async function steerQueuedMessage(threadId: string, messageId: string, turnExecutionId: string): Promise<void> {
  const message = findQueued(threadId, (item) => item.id === messageId);
  if (!message || !isSteerable(message)) return;
  const steer: SteeringSteer = { state: "steering", steerId: crypto.randomUUID(), turnExecutionId };
  useQueueStore.getState().setQueuedSteer(threadId, messageId, steer);
  await callSteer(threadId, { ...message, steer }, steer);
}

function showSettleFailure(error: unknown): void {
  const meta = error instanceof Error ? error.message : String(error);
  useToastStore.getState().show({ kind: "failed", title: "Could not settle the message", meta });
}

/** Send again: the server stores a resend under a replacement id, which this item becomes. */
export async function sendHeldSteerAgain(threadId: string, steerId: string): Promise<void> {
  try {
    const result = await getTransport().settleUnknownSteer({ messageId: steerId, action: "send-again" });
    const queue = useQueueStore.getState();
    if (result.status === "requeued") {
      queue.requeueAsResend(threadId, steerId, result.replacementMessageId);
      return;
    }
    const held = findQueued(threadId, (item) => item.steer?.state === "delivery_unknown" && item.steer.steerId === steerId);
    if (held) queue.removeFromQueue(threadId, held.id);
  } catch (error) {
    showSettleFailure(error);
  }
}

/**
 * Settles a held steer or queued resend with `remove`, so no window or reload brings it back.
 * Returns false when the server could not be asked, leaving the item where it was.
 */
export async function removeHeldSteer(steerId: string): Promise<boolean> {
  try {
    await getTransport().settleUnknownSteer({ messageId: steerId, action: "remove" });
    return true;
  } catch (error) {
    showSettleFailure(error);
    return false;
  }
}

/** The server id of the held steer behind a queue item, if it has one. */
export function heldSteerId(message: QueuedMessage): string | undefined {
  if (message.steer?.state === "resend") return message.steer.resendOfSteerId;
  if (message.steer?.state === "delivery_unknown") return message.steer.steerId;
  return undefined;
}

function adoptedMessage(held: HeldSteer, id: string, steer: QueuedSteer): QueuedMessage {
  const thread = useWorkspaceStore.getState().threads.find((item) => item.id === held.threadId);
  return {
    id,
    content: held.content,
    ...(held.mentions ? { mentions: held.mentions } : {}),
    attachments: [],
    // Empty inherits the thread's model at send time; the server stores only the text.
    model: thread?.model ?? "",
    permissionMode: useThreadStore.getState().getThreadSettings(held.threadId).permissionMode,
    queuedAt: Date.now(),
    steer,
  };
}

function mergeHeldSteer(held: HeldSteer): void {
  const queue = useQueueStore.getState();
  const local = findQueued(held.threadId, (item) =>
    (item.steer?.state === "steering" || item.steer?.state === "delivery_unknown") && item.steer.steerId === held.messageId);
  if (held.state === "delivery_unknown") {
    if (local) queue.setQueuedSteer(held.threadId, local.id, { state: "delivery_unknown", steerId: held.messageId });
    else queue.adoptHeldSteer(held.threadId, adoptedMessage(held, crypto.randomUUID(), { state: "delivery_unknown", steerId: held.messageId }));
    return;
  }
  if (local) {
    queue.setQueuedSteer(held.threadId, local.id, { state: "delivery_unknown", steerId: held.messageId });
    queue.requeueAsResend(held.threadId, held.messageId, held.replacementMessageId);
    return;
  }
  queue.adoptHeldSteer(held.threadId, adoptedMessage(held, held.replacementMessageId,
    { state: "resend", resendOfSteerId: held.messageId }));
}

/**
 * Runs on every connect. Unanswered steers are asked again under the same id, which the server
 * answers from its row and never resends, then every held steer is restored to the tray.
 */
export async function restoreQueuedSteers(): Promise<void> {
  const queues = useQueueStore.getState().queues;
  const unanswered = Object.entries(queues).flatMap(([threadId, messages]) =>
    messages.flatMap((message) => message.steer?.state === "steering"
      ? [callSteer(threadId, message, message.steer)]
      : []));
  await Promise.all(unanswered);
  const held = await getTransport().listHeldSteers();
  for (const steer of held) mergeHeldSteer(steer);
}
