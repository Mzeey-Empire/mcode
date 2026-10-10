import type { Database } from "bun:sqlite";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { inject, injectable } from "tsyringe";
import type { TurnSnapshot } from "@mcode/contracts";
import { canonicalAgentItems, canonicalAgentTurns, messages } from "../../../../runtime/persistence/sqlite/schema.js";
import { TurnSnapshotRepo } from "../../../agents/turns/persistence/turn-snapshot-repo.js";
import { deriveTurnAssistantMessageId } from "../../../agents/turns/turn-assistant-message-id.js";
import { attributedWorkspacePaths, collectAttributedWorkspacePathGroups } from "./snapshot-attribution.js";

/** A whole logical turn, including attempts whose snapshot was never written. */
export interface SnapshotTurn {
  messageId: string;
  messageIds: string[];
  ordinal: number;
  createdAt: string;
  phase: "live" | "settled";
  complete: boolean;
  rows: TurnSnapshot[];
}

/** Complete attributed evidence, or an expired logical turn. */
export type TurnSnapshotRange = {
  status: "ready";
  rows: [TurnSnapshot, ...TurnSnapshot[]];
  refBefore: string;
  refAfter: string;
  paths: string[];
  pathGroups: string[][];
} | { status: "unavailable"; reason: "snapshot-expired" };

type Attempt = typeof canonicalAgentTurns.$inferSelect;
type OrderedMessage = { id: string; role: string; timestamp: string; executionId: string | null; turnId: string | null };
type MessageGroup = { ordinal: number; createdAt: string; messages: OrderedMessage[] };

/** Reads attempt membership independently of the snapshot retention table. */
@injectable()
export class TurnSnapshotRangeReader {
  constructor(@inject("Database") private readonly db: Database, @inject(TurnSnapshotRepo) private readonly snapshots: TurnSnapshotRepo) {}

  /** Resolve any attempt's message to its whole turn, optionally spanning whole turns. */
  turnSnapshotRange(threadId: string, messageId: string, fromMessageId?: string): TurnSnapshotRange {
    const turns = this.listTurns(threadId);
    const end = turns.findIndex((turn) => turn.messageIds.includes(messageId));
    if (end < 0) return { status: "unavailable", reason: "snapshot-expired" };
    if (!fromMessageId) return snapshotRange(turns[end]?.complete ? turns[end].rows : []);
    const start = turns.findIndex((turn) => turn.messageIds.includes(fromMessageId));
    if (start < 0 || start > end) return { status: "unavailable", reason: "snapshot-expired" };
    return snapshotRange(turns.slice(start, end + 1).flatMap((turn) => turn.complete ? turn.rows : []));
  }

  /** Keep ordinals tied to message order even when snapshots disappear or attempts are replaced. */
  listTurns(threadId: string): SnapshotTurn[] {
    const orm = drizzle(this.db);
    const attempts = orm.select().from(canonicalAgentTurns).where(eq(canonicalAgentTurns.threadId, threadId))
      .orderBy(asc(canonicalAgentTurns.createdAt), asc(sql`${canonicalAgentTurns}.rowid`)).all();
    const ordered = orm.select({ id: messages.id, role: messages.role, timestamp: messages.timestamp,
      executionId: messages.outcomeExecutionId, turnId: sql<string | null>`coalesce(${canonicalAgentItems.turnId}, ${messages.sourceTurnId})`,
    }).from(messages).leftJoin(canonicalAgentItems, eq(canonicalAgentItems.id, sql`'message:' || ${messages.id}`))
      .where(and(eq(messages.threadId, threadId), eq(messages.isInternal, 0))).orderBy(asc(messages.sequence), asc(messages.id)).all();
    return collectTurns(threadId, ordered, attempts, this.snapshots.listByThread(threadId));
  }

  /** Hide every remaining row of an incomplete turn from cumulative readers. */
  listSnapshots(threadId: string): TurnSnapshot[] {
    return this.listTurns(threadId).flatMap((turn) => turn.complete
      ? turn.rows.map((row) => ({ ...row, attempt_count: turn.rows.length })) : []);
  }
}

function collectTurns(threadId: string, ordered: OrderedMessage[], attempts: Attempt[], snapshots: TurnSnapshot[]): SnapshotTurn[] {
  const byExecution = new Map(attempts.map((attempt) => [attempt.executionId, attempt]));
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const groups = groupMessages(ordered, byExecution, byId);
  const byMessage = new Map(snapshots.map((row) => [row.message_id, row]));
  const attemptsByTurn = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const key = turnKey(attempt);
    const members = attemptsByTurn.get(key) ?? [];
    members.push(attempt);
    attemptsByTurn.set(key, members);
  }
  return [...groups.entries()].flatMap(([key, group]) => snapshotTurn(threadId, group, attemptsByTurn.get(key) ?? [], byExecution, byMessage));
}

function groupMessages(ordered: OrderedMessage[], byExecution: Map<string, Attempt>, byId: Map<string, Attempt>): Map<string, MessageGroup> {
  const groups = new Map<string, MessageGroup>();
  let ordinal = 0;
  let legacyUserOrdinal: number | undefined;
  for (const message of ordered) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const attempt = messageAttempt(message, byExecution, byId);
    if (!attempt && message.role === "user") { legacyUserOrdinal = ++ordinal; continue; }
    const key = attempt ? turnKey(attempt) : message.id;
    let group = groups.get(key);
    if (!group) {
      const number = attempt ? ++ordinal : legacyUserOrdinal ?? ++ordinal;
      group = { ordinal: number, createdAt: message.timestamp, messages: [] };
      groups.set(key, group);
    }
    legacyUserOrdinal = undefined;
    group.messages.push(message);
  }
  return groups;
}

function messageAttempt(message: OrderedMessage, byExecution: Map<string, Attempt>, byId: Map<string, Attempt>): Attempt | undefined {
  return message.role === "assistant" ? byExecution.get(message.executionId ?? "") : byId.get(message.turnId ?? "");
}

function turnKey(attempt: Attempt): string {
  return attempt.attemptOf ?? attempt.id;
}

function snapshotTurn(threadId: string, group: MessageGroup, members: Attempt[], byExecution: Map<string, Attempt>, byMessage: Map<string, TurnSnapshot>): SnapshotTurn[] {
  const assistant = group.messages.filter((message) => message.role === "assistant");
  const latestAttempt = members.at(-1);
  const live = isLive(latestAttempt);
  const user = group.messages.filter((message) => message.role === "user").at(-1);
  if (latestAttempt && live && user) {
    // Live assistant rows are internal and have no execution identity until settlement.
    assistant.push({ ...user, id: deriveTurnAssistantMessageId(threadId, user.id), role: "assistant", executionId: latestAttempt.executionId });
  }
  const latest = assistant.at(-1);
  if (!latest) return [];
  const complete = assistant.every((message) => {
    const attempt = message.executionId ? byExecution.get(message.executionId) : undefined;
    return isLive(attempt) || byMessage.has(message.id);
  });
  const rows = assistant.flatMap((message) => {
    const row = byMessage.get(message.id);
    return row && (message === latest || attributedWorkspacePaths(row).length > 0) ? [row] : [];
  });
  return [{ messageId: latest.id, messageIds: assistant.map((message) => message.id), ordinal: group.ordinal,
    createdAt: group.createdAt, phase: live ? "live" as const : "settled" as const, complete, rows }];
}

function isLive(attempt: Attempt | undefined): boolean {
  return attempt?.status === "Pending" || attempt?.status === "Running";
}

/** Build range refs and attribution without collapsing rename groups from different rows. */
export function snapshotRange(rows: readonly TurnSnapshot[]): TurnSnapshotRange {
  const first = rows[0];
  const last = rows.at(-1);
  if (!first || !last) return { status: "unavailable", reason: "snapshot-expired" };
  const pathGroups = collectAttributedWorkspacePathGroups(rows);
  return { status: "ready", rows: [first, ...rows.slice(1)], refBefore: first.ref_before, refAfter: last.ref_after,
    pathGroups, paths: [...new Set(pathGroups.flat())] };
}
