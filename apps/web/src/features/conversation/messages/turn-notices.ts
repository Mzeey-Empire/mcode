import { CONTEXT_COMPACTED_NOTICE, type Message } from "@mcode/contracts/models/message";
import type { TurnNotice } from "../narrative/types";

/** Where each context-compaction notice renders: among a turn's rows, or as its own message row. */
export interface TurnNoticePlacement {
  /** Messages that still render as their own rows. */
  messages: readonly Message[];
  /** Notices keyed by the answer of the settled turn they happened in. */
  byResponseId: Readonly<Record<string, readonly Message[]>>;
  /** Notices of the live turn, shown among its live rows. */
  live: readonly TurnNotice[];
}

/** The live turn that takes notices into its rows. */
export interface LiveNoticeOwner {
  /** The live turn's answer, when one is already saved. */
  responseId: string | undefined;
  /** True while the live turn shows rows, so notices after the last prompt or answer join them. */
  ownsTrailing: boolean;
}

interface PlacementDraft {
  byResponseId: Record<string, readonly Message[]>;
  live: TurnNotice[];
  moved: Set<string>;
}

const NO_NOTICES_BY_RESPONSE: Readonly<Record<string, readonly Message[]>> = {};
const NO_LIVE_NOTICES: readonly TurnNotice[] = [];
const turnNoticeCache = new WeakMap<Message, TurnNotice>();

function isContextCompactedNotice(message: Message): boolean {
  return message.role === "system" && message.content === CONTEXT_COMPACTED_NOTICE && !message.systemNotice;
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
 * A compaction's message takes the next message sequence when it ends, so mid-turn it sorts above all of
 * the turn's work. Each notice joins the turn it happened in: the next answer, unless a prompt comes first.
 * A notice with no turn to join keeps its own row.
 */
export function placeTurnNotices(messages: readonly Message[], owner: LiveNoticeOwner): TurnNoticePlacement {
  const draft: PlacementDraft = { byResponseId: {}, live: [], moved: new Set() };
  let pending: Message[] = [];
  for (const message of messages) {
    if (isContextCompactedNotice(message)) {
      pending.push(message);
      continue;
    }
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.id === owner.responseId) moveToLiveTurn(draft, pending);
    else if (message.role === "assistant") moveToSettledTurn(draft, pending, message.id);
    pending = [];
  }
  if (owner.ownsTrailing) moveToLiveTurn(draft, pending);
  return placementFrom(messages, draft);
}

function moveToLiveTurn(draft: PlacementDraft, notices: readonly Message[]): void {
  draft.live.push(...notices.map(turnNoticeFromMessage));
  for (const notice of notices) draft.moved.add(notice.id);
}

function moveToSettledTurn(draft: PlacementDraft, notices: readonly Message[], responseId: string): void {
  if (notices.length === 0) return;
  draft.byResponseId[responseId] = notices;
  for (const notice of notices) draft.moved.add(notice.id);
}

function placementFrom(messages: readonly Message[], draft: PlacementDraft): TurnNoticePlacement {
  if (draft.moved.size === 0) return { messages, byResponseId: NO_NOTICES_BY_RESPONSE, live: NO_LIVE_NOTICES };
  return {
    messages: messages.filter((message) => !draft.moved.has(message.id)),
    byResponseId: draft.byResponseId,
    live: draft.live.length > 0 ? draft.live : NO_LIVE_NOTICES,
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
