import type { Database } from "bun:sqlite";
import { databaseWriteHandler } from "../../runtime/persistence/sqlite/database-write-operation.js";
import { MessageStore } from "./conversation/persistence/message-store.js";
import { messageWriteOperations } from "./conversation/persistence/message-write-operations.js";
import { ToolCallRecordStore } from "./tools/persistence/tool-call-record-store.js";
import { toolCallRecordWriteOperations } from "./tools/persistence/tool-call-record-write-operations.js";
import { ThoughtSegmentStore } from "./conversation/narrative/persistence/thought-segment-store.js";
import { recoveredNarrativeRows } from "./conversation/narrative/recovered-narrative-rows.js";
import { recoveredNarrativeWriteOperation } from "./conversation/narrative/persistence/recovered-narrative-write-operation.js";
import { thoughtSegmentWriteOperations } from "./conversation/narrative/persistence/thought-segment-write-operations.js";
import { HookExecutionStore } from "./events/persistence/hook-execution-store.js";
import { hookExecutionWriteOperations } from "./events/persistence/hook-execution-write-operations.js";
import { TaskStore } from "./orchestration/persistence/task-store.js";
import { taskWriteOperations } from "./orchestration/persistence/task-write-operations.js";
import { PlanStore } from "./planning/persistence/plan-store.js";
import { planWriteOperations } from "./planning/persistence/plan-write-operations.js";
import { PlanQuestionAnswersStore } from "./planning/persistence/plan-question-answers-store.js";
import { planQuestionAnswersWriteOperations } from "./planning/persistence/plan-question-answers-write-operations.js";
import { TurnSnapshotStore } from "./turns/persistence/turn-snapshot-store.js";
import { turnSnapshotWriteOperations } from "./turns/persistence/turn-snapshot-write-operations.js";
import { TurnDiffStore } from "./turns/persistence/turn-diff-store.js";
import { turnDiffWriteOperations } from "./turns/persistence/turn-diff-write-operations.js";

function messageHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new MessageStore(db);
  const ops = messageWriteOperations;
  return new Map([
    [ops.create.name, databaseWriteHandler(ops.create, input => store.create(...input))],
    [ops.createSystemNotice.name, databaseWriteHandler(ops.createSystemNotice, input => store.createSystemNotice(...input))],
    [ops.beginNoticeSession.name, databaseWriteHandler(ops.beginNoticeSession, input => store.beginNoticeSession(...input))],
    [ops.createAssistantIdempotent.name, databaseWriteHandler(ops.createAssistantIdempotent, input => store.createAssistantIdempotent(...input))],
    [ops.setAssistantOutcome.name, databaseWriteHandler(ops.setAssistantOutcome, input => store.setAssistantOutcome(...input))],
    [ops.publishAssistant.name, databaseWriteHandler(ops.publishAssistant, input => store.publishAssistant(...input))],
    [ops.appendAttachments.name, databaseWriteHandler(ops.appendAttachments, input => store.appendAttachments(...input))],
  ]);
}

function narrativeHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const tools = new ToolCallRecordStore(db);
  const thoughts = new ThoughtSegmentStore(db);
  const hooks = new HookExecutionStore(db);
  const tool = toolCallRecordWriteOperations;
  const thought = thoughtSegmentWriteOperations;
  const hook = hookExecutionWriteOperations;
  return new Map([
    [recoveredNarrativeWriteOperation.name, databaseWriteHandler(recoveredNarrativeWriteOperation, ([messageId, items, replaceExisting]) => {
      const rows = recoveredNarrativeRows(messageId, items);
      tools.bulkCreate(rows.tools, replaceExisting);
      thoughts.bulkCreate(rows.thoughts, replaceExisting);
      hooks.bulkCreate(rows.hooks, replaceExisting);
    })],
    [tool.create.name, databaseWriteHandler(tool.create, input => tools.create(...input))],
    [tool.bulkCreate.name, databaseWriteHandler(tool.bulkCreate, input => tools.bulkCreate(...input))],
    [tool.createBoundedBatch.name, databaseWriteHandler(tool.createBoundedBatch, input => tools.createBoundedBatch(...input))],
    [tool.updateSubagentIdentity.name, databaseWriteHandler(tool.updateSubagentIdentity, input => tools.updateSubagentIdentity(...input))],
    [thought.create.name, databaseWriteHandler(thought.create, input => thoughts.create(...input))],
    [thought.bulkCreate.name, databaseWriteHandler(thought.bulkCreate, input => thoughts.bulkCreate(...input))],
    [thought.createBoundedBatch.name, databaseWriteHandler(thought.createBoundedBatch, input => thoughts.createBoundedBatch(...input))],
    [hook.create.name, databaseWriteHandler(hook.create, input => hooks.create(...input))],
    [hook.bulkCreate.name, databaseWriteHandler(hook.bulkCreate, input => hooks.bulkCreate(...input))],
    [hook.createBoundedBatch.name, databaseWriteHandler(hook.createBoundedBatch, input => hooks.createBoundedBatch(...input))],
  ]);
}

function taskHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const store = new TaskStore(db);
  const ops = taskWriteOperations;
  return new Map([
    [ops.upsert.name, databaseWriteHandler(ops.upsert, input => store.upsert(...input))],
    [ops.upsertGroup.name, databaseWriteHandler(ops.upsertGroup, input => store.upsertGroup(...input))],
    [ops.appendTask.name, databaseWriteHandler(ops.appendTask, input => store.appendTask(...input))],
    [ops.updateTask.name, databaseWriteHandler(ops.updateTask, input => store.updateTask(...input))],
    [ops.removeTask.name, databaseWriteHandler(ops.removeTask, input => store.removeTask(...input))],
    [ops.delete.name, databaseWriteHandler(ops.delete, input => store.delete(...input))],
  ]);
}

function planAndTurnHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const plans = new PlanStore(db);
  const answers = new PlanQuestionAnswersStore(db);
  const snapshots = new TurnSnapshotStore(db);
  const diffs = new TurnDiffStore(db);
  const plan = planWriteOperations;
  const answer = planQuestionAnswersWriteOperations;
  const snapshot = turnSnapshotWriteOperations;
  const diff = turnDiffWriteOperations;
  return new Map([
    [plan.create.name, databaseWriteHandler(plan.create, input => plans.create(...input))],
    [plan.updateStatus.name, databaseWriteHandler(plan.updateStatus, input => plans.updateStatus(...input))],
    [answer.markAnswered.name, databaseWriteHandler(answer.markAnswered, input => answers.markAnswered(...input))],
    [snapshot.create.name, databaseWriteHandler(snapshot.create, input => snapshots.create(...input))],
    [snapshot.deleteExpired.name, databaseWriteHandler(snapshot.deleteExpired, input => snapshots.deleteExpired(...input))],
    [diff.create.name, databaseWriteHandler(diff.create, input => diffs.create(...input))],
  ]);
}

/** Agent feature operation contribution constructed only against the worker's writable database. */
export function agentStorageWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  return new Map([...messageHandlers(db), ...narrativeHandlers(db), ...taskHandlers(db), ...planAndTurnHandlers(db)]);
}
