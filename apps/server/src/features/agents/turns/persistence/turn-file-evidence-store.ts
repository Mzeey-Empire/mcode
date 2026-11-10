import type { Database } from "bun:sqlite";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { TurnFileEvidenceSchema, type TurnFileEvidenceEvent } from "@mcode/contracts/models/turn-file-evidence";
import { canonicalAgentIngestCheckpoints, messages, threads, turnFileEvidence } from "../../../../runtime/persistence/sqlite/schema.js";
import { databaseWriteHandler, databaseWriteOperation } from "../../../../runtime/persistence/sqlite/database-write-operation.js";
import { snapshotInput } from "./turn-snapshot-write-operations.js";
import { TurnSnapshotStore } from "./turn-snapshot-store.js";
import { TurnDiffStore } from "./turn-diff-store.js";

const identity = z.object({ threadId: z.string(), turnId: z.string(), executionId: z.string() });
const resolution = identity.extend({
  evidence: TurnFileEvidenceSchema(),
  snapshot: snapshotInput.omit({ messageId: true }).nullable(),
  diff: z.object({ thread_id: z.string(), source: z.enum(["native", "tracked", "git"]), patch: z.string().nullable(), revision: z.number() }).nullable(),
});

/** Start tracking only after the execution's durable admission. */
export const beginTurnFileEvidence = databaseWriteOperation("turnFileEvidence.begin", identity, z.null());
/** Resolve tracking and its review artifacts in the same writer transaction. */
export const recordTurnFileEvidence = databaseWriteOperation("turnFileEvidence.record", resolution, z.enum(["terminal-not-saved", "resolved", "untracked"]));

/** Narrows an evidence read; every field is optional and they combine with AND. */
export interface TurnFileEvidenceFilter {
  readonly threadId?: string;
  readonly executionId?: string;
  readonly tracking?: boolean;
  /** Keep rows owned by these assistant messages, plus rows with no assistant message when `unattached`. */
  readonly messages?: { readonly ids: readonly string[]; readonly unattached: boolean };
}

interface EvidenceRow { threadId: string; turnId: string; executionId: string; evidenceJson: string; messageId: string | null }

// Turn ends, page loads and boot all read here, so the owning message is resolved in the same
// indexed statement instead of one query per row.
const EVIDENCE_ROWS = `SELECT * FROM (SELECT e.thread_id AS threadId, e.turn_id AS turnId, e.execution_id AS executionId,
  e.state AS state, e.evidence_json AS evidenceJson,
  (SELECT m.id FROM messages m WHERE m.outcome_execution_id = e.execution_id AND m.thread_id = e.thread_id
    AND m.role = 'assistant' LIMIT 1) AS messageId
  FROM turn_file_evidence e)`;

/** Read evidence without depending on retained diff snapshots. Missing rows remain legacy-owned. */
export function listTurnFileEvidence(db: Database, filter: TurnFileEvidenceFilter = {}): TurnFileEvidenceEvent[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.threadId !== undefined) { where.push("threadId = ?"); params.push(filter.threadId); }
  if (filter.executionId !== undefined) { where.push("executionId = ?"); params.push(filter.executionId); }
  if (filter.tracking) where.push("state = 'tracking'");
  if (filter.messages) {
    where.push(`(messageId IN (SELECT value FROM json_each(?))${filter.messages.unattached ? " OR messageId IS NULL" : ""})`);
    params.push(JSON.stringify(filter.messages.ids));
  }
  const sql = where.length ? `${EVIDENCE_ROWS} WHERE ${where.join(" AND ")}` : EVIDENCE_ROWS;
  return db.query<EvidenceRow, string[]>(sql).all(...params).map((row) => ({
    threadId: row.threadId, turnId: row.turnId, executionId: row.executionId, messageId: row.messageId,
    evidence: TurnFileEvidenceSchema().parse(JSON.parse(row.evidenceJson)),
  }));
}

/** Allowlisted persistence for execution evidence; the application writer owns the transaction. */
export function turnFileEvidenceWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const orm = drizzle(db);
  const checkpointOf = (executionId: string) => orm.select().from(canonicalAgentIngestCheckpoints).where(eq(canonicalAgentIngestCheckpoints.executionId, executionId)).get();
  const owner = (input: z.infer<typeof identity>, checkpoint = checkpointOf(input.executionId)) => {
    if (!checkpoint || checkpoint.threadId !== input.threadId || checkpoint.turnId !== input.turnId) throw new Error("File evidence execution ownership mismatch");
    return checkpoint;
  };
  const artifacts = (input: z.infer<typeof resolution>, outcome: string) => {
    const message = orm.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, input.threadId), eq(messages.outcomeExecutionId, input.executionId), eq(messages.role, "assistant"))).get();
    // The agent's own diff does not depend on Mcode's snapshot, so it is kept when the file list is unavailable or untracked.
    if (message && input.diff && outcome === "completed") new TurnDiffStore(db).create({ id: crypto.randomUUID(), message_id: message.id, ...input.diff });
    if (input.evidence.state !== "recorded") return;
    if (message && input.snapshot) new TurnSnapshotStore(db).create({ ...input.snapshot, messageId: message.id });
    if (input.evidence.filesChanged.length || input.evidence.fileEffects?.fileCount) orm.update(threads).set({ hasFileChanges: 1 }).where(eq(threads.id, input.threadId)).run();
  };
  return new Map([
    [beginTurnFileEvidence.name, databaseWriteHandler(beginTurnFileEvidence, (input) => {
      owner(input);
      orm.insert(turnFileEvidence).values({ ...input, state: "tracking", evidenceJson: JSON.stringify({ state: "tracking" }), recordedAt: new Date().toISOString() }).onConflictDoNothing().run();
      return null;
    })],
    [recordTurnFileEvidence.name, databaseWriteHandler(recordTurnFileEvidence, (input) => {
      // A deleted thread cascades its checkpoint and evidence away; retrying could never succeed.
      const found = checkpointOf(input.executionId);
      if (!found) return "untracked";
      const checkpoint = owner(input, found);
      if (!checkpoint.terminalOutcome) return "terminal-not-saved";
      const row = orm.select().from(turnFileEvidence).where(eq(turnFileEvidence.executionId, input.executionId)).get();
      if (!row) return "untracked";
      if (row.state !== "tracking") return "resolved";
      if (input.evidence.state === "tracking") throw new Error("Evidence resolution cannot remain tracking");
      assertArtifacts(input);
      artifacts(input, checkpoint.terminalOutcome);
      orm.update(turnFileEvidence).set({ state: input.evidence.state, evidenceJson: JSON.stringify(input.evidence), recordedAt: new Date().toISOString() }).where(and(eq(turnFileEvidence.executionId, input.executionId), eq(turnFileEvidence.state, "tracking"))).run();
      return "resolved";
    })],
  ]);
}

function assertArtifacts(input: z.infer<typeof resolution>): void {
  if (input.snapshot && input.snapshot.threadId !== input.threadId) throw new Error("Snapshot ownership mismatch");
  if (input.diff && input.diff.thread_id !== input.threadId) throw new Error("Diff ownership mismatch");
  if (!input.snapshot) return;
  if (input.evidence.state !== "recorded") throw new Error("Unrecorded evidence cannot own a snapshot");
  if (JSON.stringify(input.snapshot.filesChanged) !== JSON.stringify(input.evidence.filesChanged)
    || JSON.stringify(input.snapshot.fileEffects) !== JSON.stringify(input.evidence.fileEffects)) throw new Error("Snapshot does not match evidence");
}
