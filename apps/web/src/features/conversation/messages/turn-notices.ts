import { CONTEXT_COMPACTED_NOTICE, type Message } from "@mcode/contracts/models/message";
import { replyPlacesVisual } from "../html-visual/visual-marker";
import type { TurnNotice } from "../narrative/types";

/** Where each context-compaction notice and HTML visual renders: within a turn, or as its own message row. */
export interface TurnNoticePlacement {
  /** Messages that still render as their own rows. */
  messages: readonly Message[];
  /** Notices keyed by the answer of the settled turn they happened in. */
  byResponseId: Readonly<Record<string, readonly Message[]>>;
  /** Notices of the live turn, shown among its live rows. */
  live: readonly TurnNotice[];
  /** Visual messages keyed by the answer of the settled turn that published them, in publication order. */
  visualsByResponseId: Readonly<Record<string, readonly Message[]>>;
  /** Visual messages of the live turn, shown below its live rows. */
  liveVisuals: readonly Message[];
}

/** The live turn that takes notices into its rows. */
export interface LiveNoticeOwner {
  /** The live turn's answer, when one is already saved. */
  responseId: string | undefined;
  /** True while the live turn shows rows, so notices after the last prompt or answer join them. */
  ownsTrailing: boolean;
}

interface PendingTurnMessages {
  notices: Message[];
  visuals: Message[];
}

interface PlacementDraft {
  byResponseId: Record<string, readonly Message[]>;
  live: TurnNotice[];
  visualsByResponseId: Record<string, readonly Message[]>;
  liveVisuals: Message[];
  moved: Set<string>;
}

const NO_NOTICES_BY_RESPONSE: Readonly<Record<string, readonly Message[]>> = {};
const NO_LIVE_NOTICES: readonly TurnNotice[] = [];
const NO_VISUALS_BY_RESPONSE: Readonly<Record<string, readonly Message[]>> = {};
const NO_LIVE_VISUALS: readonly Message[] = [];
const turnNoticeCache = new WeakMap<Message, TurnNotice>();

function isContextCompactedNotice(message: Message): boolean {
  return message.role === "system" && message.content === CONTEXT_COMPACTED_NOTICE && !message.systemNotice;
}

function isVisualMessage(message: Message): boolean {
  return message.role === "system" && Boolean(message.visual);
}

function isPlacedInAnswer(visual: Message, answer: Message): boolean {
  // Placement is never saved, so a settled turn reads the marker alone.
  return replyPlacesVisual(answer.content, visual.id);
}

/** Maps a notice message to its row model, keeping its identity stable across renders. */
export function turnNoticeFromMessage(message: Message): TurnNotice {
  const cached = turnNoticeCache.get(message);
  if (cached) return cached;
  const at = Date.parse(message.timestamp);
  const notice: TurnNotice = { id: message.id, text: message.content, at: Number.isFinite(at) ? at : 0 };
  turnNoticeCache.set(message, notice);
  return notice;
}

/**
 * A compaction's message takes the next message sequence when it ends, and a visual's when it is published,
 * so mid-turn both sort above all of the turn's work. Each joins the turn it happened in: the next answer,
 * unless a prompt comes first. Notices go among the turn's rows; visuals go just above its answer, so they
 * read as part of the reply. One with no turn to join keeps its own row.
 */
export function placeTurnNotices(messages: readonly Message[], owner: LiveNoticeOwner): TurnNoticePlacement {
  const draft: PlacementDraft = { byResponseId: {}, live: [], visualsByResponseId: {}, liveVisuals: [], moved: new Set() };
  let pending: PendingTurnMessages = { notices: [], visuals: [] };
  // A steer adds a prompt mid-turn, so a visual published before it keeps its own row until a later reply places it.
  const unclaimed: Message[] = [];
  for (const message of messages) {
    if (isContextCompactedNotice(message)) {
      pending.notices.push(message);
      continue;
    }
    if (isVisualMessage(message)) {
      pending.visuals.push(message);
      continue;
    }
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.id === owner.responseId) moveToLiveTurn(draft, pending, unclaimed);
    else if (message.role === "assistant") moveToSettledTurn(draft, pending, message, unclaimed);
    else unclaimed.push(...pending.visuals);
    pending = { notices: [], visuals: [] };
  }
  if (owner.ownsTrailing) moveToLiveTurn(draft, pending, unclaimed);
  return placementFrom(messages, draft);
}

function moveToLiveTurn(draft: PlacementDraft, pending: PendingTurnMessages, unclaimed: Message[]): void {
  draft.live.push(...pending.notices.map(turnNoticeFromMessage));
  // An inline visual shows only where the streamed reply places it, so the live turn gives it no slot.
  draft.liveVisuals.push(...pending.visuals.filter((visual) => visual.visualPlacement !== "inline"));
  for (const message of [...pending.notices, ...pending.visuals]) draft.moved.add(message.id);
  claim(draft, unclaimed, (visual) => visual.visualPlacement === "inline");
}

function moveToSettledTurn(draft: PlacementDraft, pending: PendingTurnMessages, answer: Message, unclaimed: Message[]): void {
  if (pending.notices.length > 0) draft.byResponseId[answer.id] = pending.notices;
  const visuals = pending.visuals.filter((visual) => !isPlacedInAnswer(visual, answer));
  if (visuals.length > 0) draft.visualsByResponseId[answer.id] = visuals;
  for (const message of [...pending.notices, ...pending.visuals]) draft.moved.add(message.id);
  claim(draft, unclaimed, (visual) => isPlacedInAnswer(visual, answer));
}

/** Takes an unclaimed visual out of its own row once a reply places it, so it renders only at its marker. */
function claim(draft: PlacementDraft, unclaimed: Message[], isPlaced: (visual: Message) => boolean): void {
  for (let index = unclaimed.length - 1; index >= 0; index -= 1) {
    const visual = unclaimed[index];
    if (!visual || !isPlaced(visual)) continue;
    draft.moved.add(visual.id);
    unclaimed.splice(index, 1);
  }
}

function placementFrom(messages: readonly Message[], draft: PlacementDraft): TurnNoticePlacement {
  if (draft.moved.size === 0) {
    return { messages, byResponseId: NO_NOTICES_BY_RESPONSE, live: NO_LIVE_NOTICES, visualsByResponseId: NO_VISUALS_BY_RESPONSE, liveVisuals: NO_LIVE_VISUALS };
  }
  return {
    messages: messages.filter((message) => !draft.moved.has(message.id)),
    byResponseId: Object.keys(draft.byResponseId).length > 0 ? draft.byResponseId : NO_NOTICES_BY_RESPONSE,
    live: draft.live.length > 0 ? draft.live : NO_LIVE_NOTICES,
    visualsByResponseId: Object.keys(draft.visualsByResponseId).length > 0 ? draft.visualsByResponseId : NO_VISUALS_BY_RESPONSE,
    liveVisuals: draft.liveVisuals.length > 0 ? draft.liveVisuals : NO_LIVE_VISUALS,
  };
}

/** Creates a placer that returns the previous placement while its inputs are unchanged, so cached rows stay put. */
export function createTurnNoticePlacer(): typeof placeTurnNotices {
  let previous: { messages: readonly Message[]; owner: LiveNoticeOwner; placement: TurnNoticePlacement } | undefined;
  return (messages, owner) => {
    if (
      previous?.messages === messages
      && previous.owner.responseId === owner.responseId
      && previous.owner.ownsTrailing === owner.ownsTrailing
    ) {
      return previous.placement;
    }
    const placement = placeTurnNotices(messages, owner);
    previous = { messages, owner, placement };
    return placement;
  };
}
