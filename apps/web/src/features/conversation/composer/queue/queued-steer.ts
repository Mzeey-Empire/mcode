import type { HeldSteer, SettleUnknownSteerResult, TurnSteerResult } from "@mcode/contracts";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useQueueStore, type QueuedMessage, type QueuedSteer } from "@/stores/queueStore";
import { scheduleDrainAfterEdit, useThreadStore } from "@/stores/threadStore";
import { useToastStore } from "@/stores/toastStore";
import { getTransport, RpcError } from "@/transport";

type SteeringSteer = Extract<QueuedSteer, { state: "steering" }>;
type SettlingSteer = Extract<QueuedSteer, { state: "settling" }>;

/** Steer ids with a request on the wire, so a reconnect replay never doubles a live call. */
const steersInFlight = new Set<string>();

/**
 * A steer carries only text and mentions into the running turn's settings. A message with
 * anything else (attachments, preview annotations, a browser capture, a goal, or a per-turn
 * mode) would lose it, and one whose shown text differs from its content would be recorded
 * as the hidden text; those wait for the next turn instead.
 */
export function isSteerable(message: QueuedMessage): boolean {
  // A deny note is admitted once, as its own turn, so steering it would deliver it twice.
  return !message.steer && !message.approvalNote && carriesOnlyText(message);
}

function carriesOnlyText(message: QueuedMessage): boolean {
  return message.attachments.length === 0
    && !message.previewAnnotations
    && !message.browserCaptureSpillPaths?.length
    && !message.goalObjective
    // Every message records the thread's mode; only proactive asks for a turn of its own.
    && message.orchestrationMode !== "proactive"
    && !message.devinMode
    && (message.displayContent === undefined || message.displayContent === message.content);
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
  if (steersInFlight.has(steer.steerId)) return;
  steersInFlight.add(steer.steerId);
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
    // The turn may have ended while the steer was out, and that turn's drain skipped this item.
    scheduleDrainAfterEdit(threadId);
  } finally {
    steersInFlight.delete(steer.steerId);
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

/** The server id of the held steer behind a queue item, if it has one. */
export function heldSteerId(message: QueuedMessage): string | undefined {
  if (message.steer?.state === "resend") return message.steer.resendOfSteerId;
  if (message.steer?.state === "delivery_unknown") return message.steer.steerId;
  return undefined;
}

/**
 * Settles the held steer behind a queue item. The item stays held while the server answers,
 * so no drain sends it meanwhile, and it is restored if the server cannot be asked.
 */
async function settleHeld(
  threadId: string,
  message: QueuedMessage,
  action: "send-again" | "remove",
): Promise<{ readonly result: SettleUnknownSteerResult; readonly steerId: string; readonly previous: SettlingSteer["previous"] } | null> {
  const steer = message.steer;
  const steerId = heldSteerId(message);
  if (!steerId || (steer?.state !== "delivery_unknown" && steer?.state !== "resend")) return null;
  const queue = useQueueStore.getState();
  queue.setQueuedSteer(threadId, message.id, { state: "settling", steerId, previous: steer });
  try {
    const result = await getTransport().settleUnknownSteer({ messageId: steerId, action });
    return { result, steerId, previous: steer };
  } catch (error) {
    useQueueStore.getState().setQueuedSteer(threadId, message.id, steer);
    const meta = error instanceof Error ? error.message : String(error);
    useToastStore.getState().show({ kind: "failed", title: "Could not settle the message", meta });
    return null;
  }
}

/** Send again: the server stores a resend under a replacement id, which this item becomes. */
export async function sendHeldSteerAgain(threadId: string, message: QueuedMessage): Promise<void> {
  const settled = await settleHeld(threadId, message, "send-again");
  if (!settled) return;
  const queue = useQueueStore.getState();
  if (settled.result.status !== "requeued") {
    queue.removeFromQueue(threadId, message.id);
    return;
  }
  queue.setQueuedSteer(threadId, message.id, settled.previous);
  queue.requeueAsResend(threadId, settled.steerId, settled.result.replacementMessageId);
  scheduleDrainAfterEdit(threadId);
}

/**
 * Releases a queue item from the steer the server holds for it, before Edit or Remove.
 * Returns `plain` when the item is now an ordinary queued message, `sent` when another
 * window already sent or removed it, and `kept` when the server could not be asked.
 */
export async function releaseHeldSteer(threadId: string, message: QueuedMessage): Promise<"plain" | "sent" | "kept"> {
  if (!heldSteerId(message)) return "plain";
  const settled = await settleHeld(threadId, message, "remove");
  if (!settled) return "kept";
  if (settled.result.status === "closed") {
    useQueueStore.getState().removeFromQueue(threadId, message.id);
    return "sent";
  }
  useQueueStore.getState().setQueuedSteer(threadId, message.id, undefined);
  return "plain";
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
    permissionMode: thread?.permission_mode ?? useThreadStore.getState().getThreadSettings(held.threadId).permissionMode,
    queuedAt: Date.now(),
    steer,
  };
}

function mergeHeldSteer(held: HeldSteer): void {
  const queue = useQueueStore.getState();
  const local = findQueued(held.threadId, (item) =>
    (item.steer?.state === "steering" || item.steer?.state === "delivery_unknown" || item.steer?.state === "settling")
    && item.steer.steerId === held.messageId);
  // This window is settling the steer right now; its answer decides the item.
  if (local?.steer?.state === "settling") return;
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
 * Restored resends wait for Send now, since another window may be sending the same one.
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
