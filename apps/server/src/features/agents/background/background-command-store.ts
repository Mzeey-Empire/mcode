import * as NodeCrypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { inject, injectable } from "tsyringe";
import { z } from "zod";
import { BackgroundCommandSchema, type BackgroundCommand } from "@mcode/contracts/models/tool-call-record";
import { BACKGROUND_RESTART_NOTICE_KEY_PREFIX as RESTART_NOTICE_PREFIX } from "@mcode/shared/planned-restart";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../runtime/persistence/sqlite/database-write-operation.js";
import { subscribeCommittedCanonicalEvents } from "../canonical/committed-canonical-events.js";
import { MessageStore } from "../conversation/persistence/message-store.js";
import { touchesBackgroundCalls } from "../workload/agent-workload.js";

const COMMAND_RECORD = `CASE json_extract(item.payload_json, '$.projection')
  WHEN 'toolCall' THEN json_extract(item.payload_json, '$.record')
  WHEN 'narrativeRecovery' THEN json_extract(item.payload_json, '$.narrative.record')
END`;
const COMMAND_KIND = `json_extract((${COMMAND_RECORD}), '$.background_kind') = 'command'`;
const RUNNING_COMMAND = `${COMMAND_KIND} AND json_extract((${COMMAND_RECORD}), '$.status') = 'running'`;

function runningCommandWithTask(record: string): string {
  return `json_extract(${record}, '$.status') = 'running'
    AND COALESCE(json_extract(${record}, '$.background_kind'), 'command') = 'command'
    AND NULLIF(json_extract(${record}, '$.background_task_id'), '') IS NOT NULL`;
}

const sqliteBoolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
const commandRow = BackgroundCommandSchema().extend({ awaited: sqliteBoolean });
const runningLaunch = z.object({ taskId: z.string().nullable(), executionId: z.string(), held: sqliteBoolean });
const setAwaitedOperation = databaseWriteOperation("backgroundCommand.setAwaited", z.object({
  threadId: z.string().min(1), toolCallIds: z.array(z.string().min(1)), awaited: z.boolean(),
}).strict(), z.void());
const noteRestartOperation = databaseWriteOperation("backgroundCommand.noteRestart", z.object({
  threadId: z.string().min(1), toolCallIds: z.array(z.string().min(1)).min(1),
}).strict(), z.void());

/** Worker-side registration keeps the running check and the mark in the same write transaction. */
export function backgroundCommandWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const mark = db.query(`
    INSERT OR IGNORE INTO background_command_awaits (thread_id, tool_call_id, awaited_at)
    SELECT item.thread_id, ?, ? FROM canonical_agent_items item
    JOIN threads thread ON thread.id = item.thread_id
    WHERE item.id = ? AND item.thread_id = ? AND thread.deleted_at IS NULL
      AND ((${RUNNING_COMMAND}) OR (${runningCommandWithTask(`(${COMMAND_RECORD})`)}))
  `);
  const clear = db.query("DELETE FROM background_command_awaits WHERE thread_id = ? AND tool_call_id = ?");
  const update = (input: z.output<typeof setAwaitedOperation.input>) => {
    const awaitedAt = new Date().toISOString();
    for (const toolCallId of input.toolCallIds) {
      if (input.awaited) mark.run(toolCallId, awaitedAt, `toolCall:${toolCallId}`, input.threadId);
      else clear.run(input.threadId, toolCallId);
    }
  };
  const messages = new MessageStore(db);
  return new Map([
    [setAwaitedOperation.name, databaseWriteHandler(setAwaitedOperation, update)],
    [noteRestartOperation.name, databaseWriteHandler(noteRestartOperation, ({ threadId, toolCallIds }) =>
      writeRestartWarning(db, messages, threadId, toolCallIds))],
  ]);
}

/** Read the canonical command history and change only its independent wait marks. */
@injectable()
export class BackgroundCommandStore {
  private readonly listeners = new Set<(threadId: string) => void>();

  constructor(
    @inject("Database") private readonly db: Database,
    @inject(ApplicationDatabaseWriter) private readonly writer: Pick<ApplicationDatabaseWriter, "execute">,
  ) {}

  /** Return visible commands newest first, optionally limited to running ones. */
  list(threadId: string, filter?: { running?: true }): BackgroundCommand[] {
    const kind = "json_extract(record, '$.background_kind') = 'command'";
    return this.read(threadId, filter?.running ? `${kind} AND json_extract(record, '$.status') = 'running'` : kind);
  }

  private read(threadId: string, condition: string): BackgroundCommand[] {
    const rows = this.db.query(`
      SELECT json_extract(record, '$.id') AS toolCallId,
        NULLIF(json_extract(record, '$.background_task_id'), '') AS taskId,
        COALESCE(NULLIF(json_extract(record, '$.background_label'), ''), json_extract(record, '$.input_summary')) AS label,
        json_extract(record, '$.started_at') AS startedAt, json_extract(record, '$.status') AS status,
        (awaits.tool_call_id IS NOT NULL AND json_extract(record, '$.status') = 'running') AS awaited
      FROM (
        SELECT item.thread_id, ${COMMAND_RECORD} AS record
        FROM canonical_agent_items item
        JOIN threads thread ON thread.id = item.thread_id
        WHERE item.thread_id = ? AND item.kind = 'tool-call' AND thread.deleted_at IS NULL
      ) command
      LEFT JOIN background_command_awaits awaits ON awaits.thread_id = command.thread_id
        AND awaits.tool_call_id = json_extract(record, '$.id')
      WHERE ${condition}
      ORDER BY startedAt DESC, toolCallId
    `).all(threadId);
    return rows.map((row) => commandRow.parse(row));
  }

  /** Prefer a provider task id to a tool call id, and never look outside the thread. */
  resolve(threadId: string, ids: readonly string[]): { matched: BackgroundCommand[]; unmatched: string[] } {
    const commands = this.list(threadId);
    const launches = this.read(threadId, runningCommandWithTask("record"));
    const matched: BackgroundCommand[] = [];
    const unmatched: string[] = [];
    for (const id of ids) {
      const command = launches.find((candidate) => candidate.taskId === id)
        ?? commands.find((candidate) => candidate.taskId === id)
        ?? commands.find((candidate) => candidate.toolCallId === id);
      if (command) matched.push(command);
      else unmatched.push(id);
    }
    return { matched, unmatched };
  }

  /** Commit wait marks for calls still running when the writer reaches them. */
  async setAwaited(threadId: string, toolCallIds: readonly string[], awaited: boolean): Promise<void> {
    if (toolCallIds.length === 0) return;
    await this.writer.execute(setAwaitedOperation, { threadId, toolCallIds: [...toolCallIds], awaited });
    for (const listener of this.listeners) listener(threadId);
  }

  /** Read the execution that originally launched this running command. */
  runningLaunch(threadId: string, toolCallId: string): z.output<typeof runningLaunch> | null {
    const row = this.db.query(`
      SELECT NULLIF(json_extract((${COMMAND_RECORD}), '$.background_task_id'), '') AS taskId,
        turn.execution_id AS executionId, turn.status IN ('Completed', 'Cancelled', 'Interrupted', 'Errored') AS held
      FROM canonical_agent_items item
      JOIN canonical_agent_turns turn ON turn.id = item.turn_id
      JOIN threads thread ON thread.id = item.thread_id
      WHERE item.id = ? AND item.thread_id = ? AND thread.deleted_at IS NULL AND ${RUNNING_COMMAND}
    `).get(`toolCall:${toolCallId}`, threadId);
    return row === null ? null : runningLaunch.parse(row);
  }

  /** Whether this thread's visible command history still has a live wait mark. */
  hasAwaitedRunning(threadId: string): boolean {
    return this.db.query(`${awaitedThreadsSql} AND awaits.thread_id = ? LIMIT 1`).get(threadId) !== null;
  }

  /** Visible threads with at least one marked running command. */
  threadsWithAwaitedRunning(): ReadonlySet<string> {
    const rows = this.db.query<{ threadId: string }, []>(awaitedThreadsSql).all();
    return new Set(rows.map(({ threadId }) => threadId));
  }

  /** Commit one restart warning keyed by the affected commands. */
  async noteRestartOrphans(threadId: string, toolCallIds: readonly string[]): Promise<void> {
    await this.writer.execute(noteRestartOperation, { threadId, toolCallIds: [...toolCallIds] });
  }

  /** Observe committed command changes and wait marks. */
  onChanged(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    const unsubscribe = subscribeCommittedCanonicalEvents((events) => {
      const threads = new Set(events.filter((event) => touchesBackgroundCalls(event, "command")).map((event) => event.routing.threadId));
      for (const threadId of threads) listener(threadId);
    });
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  }
}

const awaitedThreadsSql = `
  SELECT DISTINCT awaits.thread_id AS threadId FROM background_command_awaits awaits
  JOIN canonical_agent_items item ON item.id = 'toolCall:' || awaits.tool_call_id AND item.thread_id = awaits.thread_id
  JOIN threads thread ON thread.id = awaits.thread_id
  WHERE thread.deleted_at IS NULL AND ${RUNNING_COMMAND}
`;

function writeRestartWarning(db: Database, messages: MessageStore, threadId: string, toolCallIds: string[]): void {
  const itemIds = JSON.stringify(toolCallIds.map((id) => `toolCall:${id}`));
  // After a partial settlement, the surviving calls belong to turns already covered by the notice.
  const covered = db.query(`
    SELECT 1 FROM messages notice
    WHERE notice.thread_id = ? AND notice.system_notice ->> 'noticeKey' LIKE ? AND NOT EXISTS (
      SELECT 1 FROM json_each(?) call
      LEFT JOIN canonical_agent_items item ON item.id = call.value AND item.thread_id = notice.thread_id
      LEFT JOIN canonical_agent_turns turn ON turn.id = item.turn_id
      LEFT JOIN messages launch ON launch.thread_id = notice.thread_id AND launch.outcome_execution_id = turn.execution_id
      WHERE launch.sequence IS NULL OR launch.sequence >= notice.sequence
    )
    LIMIT 1
  `).get(threadId, `${RESTART_NOTICE_PREFIX}%`, itemIds);
  if (covered) return;
  const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(toolCallIds.sort())).digest("hex").slice(0, 40);
  messages.createSystemNotice(threadId, "Background commands were stopped when Mcode restarted.",
    messages.getLatestSequenceIncludingInternal(threadId) + 1,
    { kind: "warning", presentation: "timeline", noticeKey: `${RESTART_NOTICE_PREFIX}${hash}` });
}
