import type { AgentItem, AgentModelState, AgentTurn, Message, TurnOutcome } from "@mcode/contracts";
import { MODEL_PROVIDERS } from "@/lib/model-registry";
import { sameTurnEndNotice, turnEndingView, type TurnEndingView } from "./turn-ending-notice";

/** The ending a logical turn shows, anchored to the transcript message it follows. */
export interface TurnEnding {
  /** Latest attempt's canonical turn id; Retry targets it. */
  turnId: string;
  view: TurnEndingView;
}

/** What the transcript needs from canonical turns: endings by anchor message, and replaced attempts' messages. */
export interface TurnEndingsProjection {
  endingsByMessageId: Readonly<Record<string, TurnEnding>>;
  /** Messages a later attempt replaced, plus every retry's repeated user message. */
  hiddenMessageIds: ReadonlySet<string>;
}

interface TurnMessages {
  userMessageId?: string;
  assistantMessageIds: string[];
}

/** Project each logical turn as its first user message plus its latest attempt. */
export function projectTurnEndings(threadId: string, state: AgentModelState): TurnEndingsProjection {
  const turns = Object.values(state.turns).filter((turn) => turn.threadId === threadId).sort(compareTurns);
  const messagesByTurn = turnMessages(threadId, state.items);
  const logicalTurns = groupAttempts(turns);
  const providerLabel = providerName(state.threads[threadId]?.providerId);
  const endingsByMessageId: Record<string, TurnEnding> = {};
  const hiddenMessageIds = new Set<string>();

  logicalTurns.forEach((attempts, index) => {
    const first = attempts[0]!;
    const latest = attempts.at(-1)!;
    hideReplacedAttempts(attempts, messagesByTurn, hiddenMessageIds);
    const status = terminalOutcome(latest);
    const anchor = endingAnchor(first, latest, messagesByTurn);
    if (!status || !anchor) return;
    endingsByMessageId[anchor] = {
      turnId: latest.id,
      view: turnEndingView({
        status,
        ending: latest.ending,
        providerStartedAt: latest.providerStartedAt,
        durationMs: turnDurationMs(latest),
        providerLabel,
        providerSignedOut: false,
        scheduledRetryAt: null,
        isStartupTurn: index === 0,
        isLatestTurn: index === logicalTurns.length - 1,
        executionId: latest.executionId ?? null,
      }),
    };
  });
  return { endingsByMessageId, hiddenMessageIds };
}

/**
 * Keeps the previous projection when nothing it renders changed.
 * Canonical state changes on every streamed event, and a fresh object would rebuild every stable transcript row.
 */
export function reuseTurnEndings(previous: TurnEndingsProjection | undefined, next: TurnEndingsProjection): TurnEndingsProjection {
  return previous && sameIds(previous.hiddenMessageIds, next.hiddenMessageIds) && sameEndings(previous.endingsByMessageId, next.endingsByMessageId)
    ? previous
    : next;
}

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function sameEndings(left: TurnEndingsProjection["endingsByMessageId"], right: TurnEndingsProjection["endingsByMessageId"]): boolean {
  const ids = Object.keys(right);
  return Object.keys(left).length === ids.length && ids.every((id) => {
    const before = left[id];
    const after = right[id]!;
    return before !== undefined && before.turnId === after.turnId && sameView(before.view, after.view);
  });
}

function sameView(left: TurnEndingView, right: TurnEndingView): boolean {
  if (left.foldLabel !== right.foldLabel) return false;
  if (left.notice === null || right.notice === null) return left.notice === right.notice;
  return sameTurnEndNotice(left.notice, right.notice);
}

/** A retry repeats its first attempt's prompt, and its work replaces every earlier attempt's replies. */
function hideReplacedAttempts(attempts: readonly AgentTurn[], messagesByTurn: ReadonlyMap<string, TurnMessages>, hidden: Set<string>): void {
  const first = attempts[0];
  const latest = attempts.at(-1);
  for (const attempt of attempts) {
    const messages = messagesByTurn.get(attempt.id);
    if (!messages) continue;
    if (attempt !== first && messages.userMessageId) hidden.add(messages.userMessageId);
    if (attempt !== latest) messages.assistantMessageIds.forEach((id) => hidden.add(id));
  }
}

/** The latest attempt's last reply, or the turn's prompt when no attempt replied. */
function endingAnchor(first: AgentTurn, latest: AgentTurn, messagesByTurn: ReadonlyMap<string, TurnMessages>): string | undefined {
  return messagesByTurn.get(latest.id)?.assistantMessageIds.at(-1) ?? messagesByTurn.get(first.id)?.userMessageId;
}

function groupAttempts(turns: readonly AgentTurn[]): AgentTurn[][] {
  const byLogicalId = new Map<string, AgentTurn[]>();
  for (const turn of turns) {
    const logicalId = turn.attemptOf ?? turn.id;
    const attempts = byLogicalId.get(logicalId);
    if (attempts) attempts.push(turn);
    else byLogicalId.set(logicalId, [turn]);
  }
  return [...byLogicalId.values()];
}

function turnMessages(threadId: string, items: AgentModelState["items"]): Map<string, TurnMessages> {
  const byTurn = new Map<string, TurnMessages>();
  const messageItems = Object.values(items)
    .filter((item) => item.threadId === threadId && item.kind === "message")
    .sort(compareItems);
  for (const item of messageItems) {
    const message = projectedMessage(item);
    if (!message) continue;
    const entry = byTurn.get(item.turnId) ?? { assistantMessageIds: [] };
    if (message.role === "user") entry.userMessageId ??= message.id;
    if (message.role === "assistant" && !entry.assistantMessageIds.includes(message.id)) entry.assistantMessageIds.push(message.id);
    byTurn.set(item.turnId, entry);
  }
  return byTurn;
}

function projectedMessage(item: AgentItem): Pick<Message, "id" | "role"> | undefined {
  if (item.payload.projection !== "message") return undefined;
  const message = item.payload.message;
  if (!message || typeof message !== "object") return undefined;
  const { id, role } = message as Partial<Message>;
  return typeof id === "string" && (role === "user" || role === "assistant") ? { id, role } : undefined;
}

const TERMINAL_OUTCOMES: Partial<Record<AgentTurn["status"], TurnOutcome>> = {
  Completed: "completed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
  Errored: "errored",
};

function terminalOutcome(turn: AgentTurn): TurnOutcome | undefined {
  return TERMINAL_OUTCOMES[turn.status];
}

function providerName(providerId: string | undefined): string {
  return MODEL_PROVIDERS.find((provider) => provider.id === providerId)?.name ?? "The provider";
}

function turnDurationMs(turn: AgentTurn): number | null {
  const startedAt = timestamp(turn.startedAt ?? turn.createdAt);
  const endedAt = timestamp(turn.endedAt);
  return startedAt === undefined || endedAt === undefined ? null : Math.max(0, endedAt - startedAt);
}

function timestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareTurns(left: AgentTurn, right: AgentTurn): number {
  return (timestamp(left.startedAt ?? left.createdAt) ?? 0) - (timestamp(right.startedAt ?? right.createdAt) ?? 0)
    || left.id.localeCompare(right.id);
}

function compareItems(left: AgentItem, right: AgentItem): number {
  return (timestamp(left.createdAt) ?? 0) - (timestamp(right.createdAt) ?? 0) || left.id.localeCompare(right.id);
}
