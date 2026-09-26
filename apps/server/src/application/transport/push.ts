/**
 * Push event broadcasting.
 * Sends push events to all connected WebSocket clients.
 */

import type { WebSocket } from "ws";
import * as NodeCrypto from "node:crypto";
import { WS_CHANNELS, type WsChannelName, type SetThreadSubscriptionsInput, encodeTerminalDataFrame } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { getTransportPayloadValidator } from "./payload-validation.js";

/** Maximum transient agent events retained for one thread. */
export const MAX_AGENT_EVENT_JOURNAL_EVENTS_PER_THREAD = 256;
/** Maximum thread journals retained by the process. */
export const MAX_AGENT_EVENT_JOURNAL_THREADS = 100;
/** Maximum unsent push bytes for one connected client, excluding RPC response bytes. */
export const MAX_QUEUED_PUSH_BYTES = 16 * 1_024 * 1_024;

const clients = new Set<WebSocket>();
const queuedPushBytes = new Map<WebSocket, number>();
const threadSubscriptions = new Map<WebSocket, Set<string>>();
interface AgentEventJournal {
  epoch: string;
  sequence: number;
  events: unknown[];
}

const threadJournals = new Map<string, AgentEventJournal>();
const SUBSCRIPTION_SCOPED_CHANNELS = new Set<WsChannelName>([
  "agent.event",
  "agent.canonical",
  "turn.fileEffectsUpdated",
  "turn.diffChanged",
  "turn.savingStatus",
]);

let _sessionCount = 0;
const sessionChangeListeners: ((count: number) => void)[] = [];

/**
 * Get the net cumulative session count.
 *
 * Each `addClient` call increments this value; each `removeClient` call
 * decrements it. This tracks session lifecycle (total connects minus
 * total disconnects) and is distinct from `clientCount()`, which returns
 * `clients.size` - the number of sockets currently open.
 */
export function sessionCount(): number {
  return _sessionCount;
}

/**
 * Register a callback invoked whenever the session count changes.
 * Returns an unsubscribe function that removes the callback.
 */
export function onSessionChange(cb: (count: number) => void): () => void {
  sessionChangeListeners.push(cb);
  return () => {
    const idx = sessionChangeListeners.indexOf(cb);
    if (idx >= 0) sessionChangeListeners.splice(idx, 1);
  };
}

/** Register a WebSocket client for push event delivery. */
export function addClient(ws: WebSocket): void {
  clients.add(ws);
  queuedPushBytes.set(ws, 0);
  threadSubscriptions.set(ws, new Set());
  _sessionCount++;
  for (let i = 0; i < sessionChangeListeners.length; i++) sessionChangeListeners[i](_sessionCount);
}

/** Remove a disconnected WebSocket client. No-op if already removed. */
export function removeClient(ws: WebSocket): void {
  if (!clients.delete(ws)) return;
  queuedPushBytes.delete(ws);
  threadSubscriptions.delete(ws);
  _sessionCount--;
  for (let i = 0; i < sessionChangeListeners.length; i++) sessionChangeListeners[i](_sessionCount);
}

/** Subscribe a connected client to push events for one thread. */
export function subscribeClientToThread(ws: WebSocket, threadId: string): void {
  if (!clients.has(ws)) return;
  const subscriptions = threadSubscriptions.get(ws) ?? new Set<string>();
  subscriptions.add(threadId);
  threadSubscriptions.set(ws, subscriptions);
}

/** Remove a connected client's push subscription for one thread. */
export function unsubscribeClientFromThread(ws: WebSocket, threadId: string): void {
  threadSubscriptions.get(ws)?.delete(threadId);
}

/** Atomically replace a connected client's complete desired subscription set. */
export function setClientThreadSubscriptions(
  ws: WebSocket,
  threadIds: readonly string[],
  cursors?: NonNullable<SetThreadSubscriptionsInput["cursors"]>,
): { hydrationRequiredThreadIds: string[]; replayedThrough: Record<string, number> } {
  if (!clients.has(ws)) return { hydrationRequiredThreadIds: [], replayedThrough: {} };
  threadSubscriptions.set(ws, new Set(threadIds));
  const hydrationRequiredThreadIds: string[] = [];
  const replayedThrough: Record<string, number> = {};
  if (!cursors) return { hydrationRequiredThreadIds, replayedThrough };

  for (const threadId of threadIds) {
    replayThreadSubscription(
      ws,
      threadId,
      cursors[threadId],
      hydrationRequiredThreadIds,
      replayedThrough,
    );
  }
  return { hydrationRequiredThreadIds, replayedThrough };
}

function replayThreadSubscription(
  ws: WebSocket,
  threadId: string,
  rawCursor: NonNullable<SetThreadSubscriptionsInput["cursors"]>[string] | undefined,
  hydrationRequiredThreadIds: string[],
  replayedThrough: Record<string, number>,
): void {
  if (rawCursor === undefined) return;
  const cursor = typeof rawCursor === "number" ? rawCursor : rawCursor.sequence;
  const journal = threadJournals.get(threadId);
  if (requiresThreadHydration(rawCursor, cursor, journal)) {
    hydrationRequiredThreadIds.push(threadId);
    return;
  }
  if (!journal) return;
  const deliveredThrough = replayJournalEvents(ws, cursor, journal.events);
  if (deliveredThrough !== cursor) replayedThrough[threadId] = deliveredThrough;
}

function requiresThreadHydration(
  rawCursor: NonNullable<SetThreadSubscriptionsInput["cursors"]>[string],
  cursor: number,
  journal: AgentEventJournal | undefined,
): boolean {
  if (typeof rawCursor === "number" && cursor > 0) return true;
  if (!journal) return cursor > 0;
  if (typeof rawCursor !== "number" && rawCursor.epoch !== journal.epoch) return true;
  if (cursor > journal.sequence) return true;
  return journal.events.length > 0 && cursor < (journal.events[0] as { sequence: number }).sequence - 1;
}

function replayJournalEvents(ws: WebSocket, cursor: number, events: readonly unknown[]): number {
  let deliveredThrough = cursor;
  for (const event of events) {
    if ((event as { sequence: number }).sequence <= cursor) continue;
    if (!sendToClient(ws, "agent.event", event)) break;
    deliveredThrough = (event as { sequence: number }).sequence;
  }
  return deliveredThrough;
}

/** Get the current number of connected clients. */
export function clientCount(): number {
  return clients.size;
}

/**
 * Returns the maximum ws.bufferedAmount across all currently-open clients.
 * Used by the socket coordinator to drive server-side flow control.
 */
export function maxBufferedAmount(): number {
  let max = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      if (ws.bufferedAmount > max) max = ws.bufferedAmount;
    }
  }
  return max;
}

function payloadThreadId(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const threadId = (data as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}

/**
 * Broadcast a push event to all connected WebSocket clients.
 * Validates the data against the channel's Zod schema before sending.
 */
export function broadcast(
  channel: WsChannelName,
  data: unknown,
): unknown {
  const schema = WS_CHANNELS[channel];
  if (!schema) {
    logger.warn("Unknown push channel", { channel });
    return undefined;
  }

  const threadId = payloadThreadId(data);
  const candidate = decorateAgentEvent(channel, data, threadId);
  const validation = getTransportPayloadValidator().validatePush(channel, candidate, schema);
  if (!validation.ok) return undefined;
  retainAgentEvent(channel, threadId, validation.data);
  const payload = JSON.stringify({
    type: "push" as const,
    channel,
    data: validation.data,
  });
  sendBroadcastPayload(channel, threadId, payload);
  return validation.data;
}

function decorateAgentEvent(channel: WsChannelName, data: unknown, threadId: string | undefined): unknown {
  if (channel !== "agent.event" || !threadId || !data || typeof data !== "object") return data;
  const journal = threadJournals.get(threadId);
  const sequence = (journal?.sequence ?? 0) + 1;
  const epoch = journal?.epoch ?? NodeCrypto.randomUUID();
  return { ...(data as Record<string, unknown>), sequence, epoch };
}

function retainAgentEvent(channel: WsChannelName, threadId: string | undefined, event: unknown): void {
  if (channel !== "agent.event" || !threadId) return;
  if (!event || typeof event !== "object" || !("sequence" in event) || !("epoch" in event)) return;
  if (typeof event.sequence !== "number" || typeof event.epoch !== "string") return;
  const existing = threadJournals.get(threadId);
  const events = existing ? [...existing.events, event] : [event];
  events.splice(0, Math.max(0, events.length - MAX_AGENT_EVENT_JOURNAL_EVENTS_PER_THREAD));
  threadJournals.delete(threadId);
  threadJournals.set(threadId, { epoch: event.epoch, sequence: event.sequence, events });
  trimJournalMap(threadJournals);
}

function trimJournalMap(map: Map<string, unknown>): void {
  while (map.size > MAX_AGENT_EVENT_JOURNAL_THREADS) {
    map.delete(map.keys().next().value as string);
  }
}

function sendBroadcastPayload(channel: WsChannelName, threadId: string | undefined, payload: string): void {
  const requiresThreadSubscription = SUBSCRIPTION_SCOPED_CHANNELS.has(channel);
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (requiresThreadSubscription && threadId && !threadSubscriptions.get(ws)?.has(threadId)) continue;
    sendPush(ws, channel, payload, payloadBytes);
  }
}

/** Count only push writes, so a large RPC response cannot evict its own client. */
function canSendPayload(ws: WebSocket, channel: WsChannelName | "terminal.data", payloadBytes: number): boolean {
  const queuedBytes = queuedPushBytes.get(ws) ?? 0;
  if (queuedBytes + payloadBytes <= MAX_QUEUED_PUSH_BYTES) return true;
  logger.warn("Terminating slow WebSocket client for push recovery", {
    channel,
    queuedPushBytes: queuedBytes,
    bufferedAmount: ws.bufferedAmount,
    payloadBytes,
  });
  try {
    ws.terminate();
  } catch (error) {
    logger.warn("Failed to terminate slow WebSocket client", {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  removeClient(ws);
  return false;
}

function sendPush(
  ws: WebSocket,
  channel: WsChannelName | "terminal.data",
  payload: string | Uint8Array,
  payloadBytes: number,
): boolean {
  if (!canSendPayload(ws, channel, payloadBytes)) return false;
  queuedPushBytes.set(ws, (queuedPushBytes.get(ws) ?? 0) + payloadBytes);
  const complete = (error?: Error) => {
    const queued = queuedPushBytes.get(ws);
    if (queued !== undefined) queuedPushBytes.set(ws, Math.max(0, queued - payloadBytes));
    if (error) logger.warn("Push delivery failed", { channel, error: error.message });
  };
  try {
    if (typeof payload === "string") ws.send(payload, complete);
    else ws.send(payload, { binary: true }, complete);
    return true;
  } catch (error) {
    complete();
    logger.warn("Push send failed", {
      channel,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Sends one validated push event to exactly one connected WebSocket client. */
export function sendToClient(
  ws: WebSocket,
  channel: WsChannelName,
  data: unknown,
): boolean {
  if (!clients.has(ws) || ws.readyState !== ws.OPEN) return false;
  const schema = WS_CHANNELS[channel];
  if (!schema) return false;
  const validation = getTransportPayloadValidator().validatePush(channel, data, schema);
  if (!validation.ok) return false;
  const payload = JSON.stringify({ type: "push" as const, channel, data: validation.data });
  return sendPush(ws, channel, payload, Buffer.byteLength(payload, "utf8"));
}

/**
 * Broadcast a PTY data chunk as a binary WebSocket frame.
 *
 * Uses the terminal-binary envelope so clients can decode ptyId + seq without
 * a preceding text header. Non-PTY channels continue to use JSON `broadcast`.
 */
export function broadcastTerminalData(
  ptyId: string,
  seq: number,
  payload: Uint8Array,
): void {
  const frame = encodeTerminalDataFrame(ptyId, seq, payload);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      sendPush(ws, "terminal.data", frame, frame.byteLength);
    }
  }
}

/**
 * Reset module-level state to a clean baseline.
 *
 * FOR TESTING ONLY. Do not call this in production code.
 * Resets `_sessionCount` to 0, clears `sessionChangeListeners`, and
 * empties the `clients` set so each test starts from a known state.
 */
export function _resetForTest(): void {
  _sessionCount = 0;
  sessionChangeListeners.length = 0;
  clients.clear();
  queuedPushBytes.clear();
  threadSubscriptions.clear();
  threadJournals.clear();
}
