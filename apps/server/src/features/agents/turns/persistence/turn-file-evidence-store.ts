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

/** Read evidence without depending on retained diff snapshots. Missing rows remain legacy-owned. */
export function listTurnFileEvidence(db: Database, threadId?: string): TurnFileEvidenceEvent[] {
  const orm = drizzle(db);
  return orm.select().from(turnFileEvidence).where(threadId ? eq(turnFileEvidence.threadId, threadId) : undefined).all().map((row) => ({
    threadId: row.threadId, turnId: row.turnId, executionId: row.executionId,
    messageId: orm.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, row.threadId), eq(messages.outcomeExecutionId, row.executionId), eq(messages.role, "assistant"))).get()?.id ?? null,
    evidence: TurnFileEvidenceSchema().parse(JSON.parse(row.evidenceJson)),
  }));
}

/** Allowlisted persistence for execution evidence; the application writer owns the transaction. */
export function turnFileEvidenceWriteHandlers(db: Database): ReadonlyMap<string, (input: unknown) => unknown> {
  const orm = drizzle(db);
  const owner = (input: z.infer<typeof identity>) => {
    const checkpoint = orm.select().from(canonicalAgentIngestCheckpoints).where(eq(canonicalAgentIngestCheckpoints.executionId, input.executionId)).get();
    if (!checkpoint || checkpoint.threadId !== input.threadId || checkpoint.turnId !== input.turnId) throw new Error("File evidence execution ownership mismatch");
    return checkpoint;
  };
  const artifacts = (input: z.infer<typeof resolution>, outcome: string) => {
    if (input.evidence.state !== "recorded") return;
    const message = orm.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, input.threadId), eq(messages.outcomeExecutionId, input.executionId), eq(messages.role, "assistant"))).get();
    if (message) {
      if (input.snapshot) new TurnSnapshotStore(db).create({ ...input.snapshot, messageId: message.id });
      if (input.diff && outcome === "completed") new TurnDiffStore(db).create({ id: crypto.randomUUID(), message_id: message.id, ...input.diff });
    }
    if (input.evidence.filesChanged.length || input.evidence.fileEffects?.fileCount) orm.update(threads).set({ hasFileChanges: 1 }).where(eq(threads.id, input.threadId)).run();
  };
  return new Map([
    [beginTurnFileEvidence.name, databaseWriteHandler(beginTurnFileEvidence, (input) => {
      owner(input);
      orm.insert(turnFileEvidence).values({ ...input, state: "tracking", evidenceJson: JSON.stringify({ state: "tracking" }), recordedAt: new Date().toISOString() }).onConflictDoNothing().run();
      return null;
    })],
    [recordTurnFileEvidence.name, databaseWriteHandler(recordTurnFileEvidence, (input) => {
      const checkpoint = owner(input);
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
