import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { runChanges } from "../../../runtime/persistence/sqlite/drizzle-changes.js";
import {
  canonicalAgentIngestCheckpoints,
  parentAssistantTextCheckpointChunks,
  parentAssistantTextCheckpoints,
} from "../../../runtime/persistence/sqlite/schema.js";
import { ACTIVE_TURN_WRITE_BATCH_LIMITS } from "../../../runtime/persistence/sqlite/bounded-write-batches.js";
import { PARENT_ASSISTANT_TEXT_RETAINED_LIMITS } from "./active-turn-recovery-retention-policy.js";

export { PARENT_ASSISTANT_TEXT_RETAINED_LIMITS } from "./active-turn-recovery-retention-policy.js";

/** Measured production policy for durable assistant-text publication. */
export const PARENT_ASSISTANT_TEXT_QUEUE_POLICY = {
  maxChunkBytes: 16 * 1024,
  maxQueuedEvents: ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1,
  maxAgeMs: 250,
} as const;

const PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_RECORD_OVERHEAD_BYTES = 512;
const PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_MAX_BYTES =
  Math.ceil(PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes / 3) * 4
  + PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxChunks
    * PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_RECORD_OVERHEAD_BYTES;

/** One ordered assistant-text delta accepted for durable publication. */
export interface ParentAssistantTextCheckpointInput {
  executionId: string;
  threadId: string;
  turnId: string;
  sequence: number;
  text: string;
}

/** Retention limits for one unfinished assistant response. */
export interface ParentAssistantTextCheckpointLimits {
  maxBytes: number;
  maxChunks: number;
}

/** Filesystem location for the per-database assistant-text recovery journal. */
export interface ParentAssistantTextRecoveryJournalOptions {
  directory?: string;
}

/** Result of committing one concatenated assistant-text chunk. */
export interface ParentAssistantTextCheckpointResult {
  outcome: "committed" | "duplicate" | "overflow";
  durableThrough: number;
  committedItems: number;
  committedBytes: number;
}

/** One durable assistant-text chunk restored in accepted order. */
export interface RestoredParentAssistantTextChunk {
  firstSequence: number;
  lastSequence: number;
  text: string;
  byteLength: number;
}

interface PreparedParentAssistantTextCheckpointChunk {
  executionId: string;
  threadId: string;
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  text: string;
  byteLength: number;
  itemCount: number;
}

interface DurableParentAssistantTextCheckpoint {
  threadId: string;
  turnId: string;
  lastSequence: number;
  retainedBytes: number;
  retainedChunks: number;
}

/** Persists bounded chunks for unfinished ordinary parent assistant responses. */
export class ParentAssistantTextCheckpointStore {
  private readonly orm: BunSQLiteDatabase;

  constructor(
    private readonly db: Database,
    private readonly limits: ParentAssistantTextCheckpointLimits = PARENT_ASSISTANT_TEXT_RETAINED_LIMITS,
    journalOptions: ParentAssistantTextRecoveryJournalOptions = {},
  ) {
    this.orm = drizzle(db);
    this.recoveryJournal = new ParentAssistantTextRecoveryJournal(
      journalOptions.directory ?? resolveDefaultRecoveryJournalDirectory(this.db),
    );
  }

  /** Durable fallback journal scoped to this SQLite database. */
  readonly recoveryJournal: ParentAssistantTextRecoveryJournal;

  /** Commit consecutive deltas as one durable chunk and advance its cursor atomically. */
  appendChunk(inputs: readonly ParentAssistantTextCheckpointInput[]): ParentAssistantTextCheckpointResult {
    return this.appendPreparedChunk(this.prepareChunk(inputs));
  }

  /** Import one complete recovery-journal record into SQLite. */
  appendRecoveredChunk(
    input: ParentAssistantTextRecoveryJournalChunk,
  ): ParentAssistantTextCheckpointResult {
    return this.appendPreparedChunk({
      executionId: input.executionId,
      threadId: input.threadId,
      turnId: input.turnId,
      firstSequence: input.firstSequence,
      lastSequence: input.lastSequence,
      text: input.text,
      byteLength: input.byteLength,
      itemCount: input.lastSequence - input.firstSequence + 1,
    });
  }

  /** Import every fsynced journal before startup recovery reads provisional text. */
  importRecoveryJournals(): string[] {
    return this.recoveryJournal.drainAll((input) => {
      const result = this.appendRecoveredChunk(input);
      if (result.outcome === "overflow") {
        throw new Error("Assistant text recovery journal exceeds the retained checkpoint capacity");
      }
    });
  }

  private appendPreparedChunk(
    prepared: PreparedParentAssistantTextCheckpointChunk,
  ): ParentAssistantTextCheckpointResult {
    return this.db.transaction(() => this.appendPreparedChunkInTransaction(prepared))();
  }

  private appendPreparedChunkInTransaction(
    prepared: PreparedParentAssistantTextCheckpointChunk,
  ): ParentAssistantTextCheckpointResult {
    const checkpoint = this.loadCheckpoint(prepared.executionId);
    this.verifyCheckpointRouting(checkpoint, prepared);
    const durableThrough = checkpoint?.lastSequence ?? 0;
    const duplicate = this.duplicateCheckpointResult(prepared, durableThrough);
    if (duplicate) return duplicate;
    this.verifyNextSequence(prepared, durableThrough);
    const overflow = this.overflowCheckpointResult(prepared, checkpoint, durableThrough);
    if (overflow) return overflow;
    return this.insertPreparedChunk(prepared, checkpoint);
  }

  private loadCheckpoint(executionId: string): DurableParentAssistantTextCheckpoint | undefined {
    return this.orm.select({
      threadId: parentAssistantTextCheckpoints.threadId,
      turnId: parentAssistantTextCheckpoints.turnId,
      lastSequence: parentAssistantTextCheckpoints.lastSequence,
      retainedBytes: parentAssistantTextCheckpoints.retainedBytes,
      retainedChunks: parentAssistantTextCheckpoints.retainedChunks,
    }).from(parentAssistantTextCheckpoints)
      .where(eq(parentAssistantTextCheckpoints.executionId, executionId))
      .get();
  }

  private verifyCheckpointRouting(
    checkpoint: DurableParentAssistantTextCheckpoint | undefined,
    prepared: PreparedParentAssistantTextCheckpointChunk,
  ): void {
    if (checkpoint && (checkpoint.threadId !== prepared.threadId || checkpoint.turnId !== prepared.turnId)) {
      throw new Error("Assistant text checkpoint routing conflicts with its execution");
    }
  }

  private duplicateCheckpointResult(
    prepared: PreparedParentAssistantTextCheckpointChunk,
    durableThrough: number,
  ): ParentAssistantTextCheckpointResult | undefined {
    if (prepared.firstSequence > durableThrough) return undefined;
    if (prepared.lastSequence > durableThrough) {
      throw new Error("Assistant text checkpoint retry overlaps durable and new text");
    }
    const duplicate = this.orm.select({
      text: parentAssistantTextCheckpointChunks.text,
      byteLength: parentAssistantTextCheckpointChunks.byteLength,
    }).from(parentAssistantTextCheckpointChunks)
      .where(and(
        eq(parentAssistantTextCheckpointChunks.executionId, prepared.executionId),
        eq(parentAssistantTextCheckpointChunks.firstSequence, prepared.firstSequence),
        eq(parentAssistantTextCheckpointChunks.lastSequence, prepared.lastSequence),
      ))
      .get();
    if (!duplicate || duplicate.text !== prepared.text || duplicate.byteLength !== prepared.byteLength) {
      throw new Error("Assistant text checkpoint duplicate conflicts with durable text");
    }
    return { outcome: "duplicate", durableThrough, committedItems: 0, committedBytes: 0 };
  }

  private verifyNextSequence(prepared: PreparedParentAssistantTextCheckpointChunk, durableThrough: number): void {
    if (prepared.firstSequence !== durableThrough + 1) {
      throw new Error(`Assistant text checkpoint sequence gap: expected ${durableThrough + 1}, received ${prepared.firstSequence}`);
    }
  }

  private overflowCheckpointResult(
    prepared: PreparedParentAssistantTextCheckpointChunk,
    checkpoint: DurableParentAssistantTextCheckpoint | undefined,
    durableThrough: number,
  ): ParentAssistantTextCheckpointResult | undefined {
    const retainedBytes = (checkpoint?.retainedBytes ?? 0) + prepared.byteLength;
    const retainedChunks = (checkpoint?.retainedChunks ?? 0) + 1;
    if (retainedBytes <= this.limits.maxBytes && retainedChunks <= this.limits.maxChunks) return undefined;
    return { outcome: "overflow", durableThrough, committedItems: 0, committedBytes: 0 };
  }

  private insertPreparedChunk(
    prepared: PreparedParentAssistantTextCheckpointChunk,
    checkpoint: DurableParentAssistantTextCheckpoint | undefined,
  ): ParentAssistantTextCheckpointResult {
    const retainedBytes = (checkpoint?.retainedBytes ?? 0) + prepared.byteLength;
    const retainedChunks = (checkpoint?.retainedChunks ?? 0) + 1;
    this.orm.insert(parentAssistantTextCheckpoints).values({
      executionId: prepared.executionId,
      threadId: prepared.threadId,
      turnId: prepared.turnId,
      lastSequence: prepared.lastSequence,
      retainedBytes,
      retainedChunks,
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: parentAssistantTextCheckpoints.executionId,
      set: {
        lastSequence: sql`excluded.last_sequence`,
        retainedBytes: sql`excluded.retained_bytes`,
        retainedChunks: sql`excluded.retained_chunks`,
        updatedAt: sql`excluded.updated_at`,
      },
    }).run();
    this.orm.insert(parentAssistantTextCheckpointChunks).values({
      executionId: prepared.executionId,
      firstSequence: prepared.firstSequence,
      lastSequence: prepared.lastSequence,
      text: prepared.text,
      byteLength: prepared.byteLength,
    }).run();
    return {
      outcome: "committed",
      durableThrough: prepared.lastSequence,
      committedItems: prepared.itemCount,
      committedBytes: prepared.byteLength,
    };
  }

  /** Restore the exact durable text prefix in accepted order. */
  restore(executionId: string): string {
    return this.restoreChunks(executionId).map((chunk) => chunk.text).join("");
  }

  /** Restore durable chunks in accepted order for recovery and diagnostics. */
  restoreChunks(executionId: string): RestoredParentAssistantTextChunk[] {
    const rows = this.orm.select().from(parentAssistantTextCheckpointChunks)
      .where(eq(parentAssistantTextCheckpointChunks.executionId, executionId))
      .orderBy(asc(parentAssistantTextCheckpointChunks.firstSequence))
      .all();
    return rows.map((row) => ({
      firstSequence: row.firstSequence,
      lastSequence: row.lastSequence,
      text: row.text,
      byteLength: row.byteLength,
    }));
  }

  /** Discard provisional text for an unfinished execution before a fresh retry. */
  reset(executionId: string): boolean {
    const reset = this.db.transaction(() => this.resetInTransaction(executionId))();
    if (reset) this.recoveryJournal.discard(executionId);
    return reset;
  }

  /** Discard every unfinished storage tier before a provider retry starts a fresh response. */
  resetForRetry(executionId: string): boolean {
    const reset = this.db.transaction(() => this.resetForRetryInTransaction(executionId))();
    if (reset) this.recoveryJournal.discard(executionId);
    return reset;
  }

  /** Delete retry checkpoints while the application writer owns the outer transaction. */
  resetForRetryInTransaction(executionId: string): boolean {
      const unfinished = this.orm.select({ executionId: canonicalAgentIngestCheckpoints.executionId })
        .from(canonicalAgentIngestCheckpoints)
        .where(and(
          eq(canonicalAgentIngestCheckpoints.executionId, executionId),
          isNull(canonicalAgentIngestCheckpoints.terminalOutcome),
        ))
        .get();
      if (!unfinished) return false;
      this.orm.delete(parentAssistantTextCheckpoints)
        .where(eq(parentAssistantTextCheckpoints.executionId, executionId))
        .run();
      return true;
  }

  /** Discard provisional text while the caller owns the surrounding SQLite transaction. */
  resetInTransaction(executionId: string): boolean {
    return runChanges(this.orm.delete(parentAssistantTextCheckpoints)
      .where(and(
        eq(parentAssistantTextCheckpoints.executionId, executionId),
        sql`EXISTS (
          SELECT 1 FROM canonical_agent_ingest_checkpoints
          WHERE execution_id = ${parentAssistantTextCheckpoints.executionId}
            AND terminal_outcome IS NULL
        )`,
      ))).changes > 0;
  }

  /** Remove the journal after its equivalent canonical projection commits. */
  discardRecoveryJournal(executionId: string): void {
    this.recoveryJournal.discard(executionId);
  }

  /** Retire provisional text only after the canonical execution is terminal. */
  retire(executionId: string): boolean {
    const terminal = this.db.transaction(() => this.retireInTransaction(executionId))();
    if (terminal) this.recoveryJournal.discard(executionId);
    return terminal;
  }

  /** Delete terminal checkpoints while the application writer owns the outer transaction. */
  retireInTransaction(executionId: string): boolean {
      const terminal = this.orm.select({ executionId: canonicalAgentIngestCheckpoints.executionId })
        .from(canonicalAgentIngestCheckpoints)
        .where(and(
          eq(canonicalAgentIngestCheckpoints.executionId, executionId),
          isNotNull(canonicalAgentIngestCheckpoints.terminalOutcome),
        ))
        .get();
      if (!terminal) return false;
      this.orm.delete(parentAssistantTextCheckpoints)
        .where(eq(parentAssistantTextCheckpoints.executionId, executionId))
        .run();
      return true;
  }

  /** Remove stale provisional data whose canonical executions are already terminal. */
  retireTerminalCheckpoints(): number {
    return runChanges(this.orm.delete(parentAssistantTextCheckpoints)
      .where(sql`EXISTS (
        SELECT 1 FROM canonical_agent_ingest_checkpoints
        WHERE execution_id = ${parentAssistantTextCheckpoints.executionId}
          AND terminal_outcome IS NOT NULL
      )`)).changes;
  }

  private prepareChunk(
    inputs: readonly ParentAssistantTextCheckpointInput[],
  ): PreparedParentAssistantTextCheckpointChunk {
    if (inputs.length === 0) throw new Error("Assistant text checkpoint chunk must not be empty");
    if (inputs.length > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1) {
      throw new Error("Assistant text checkpoint chunk exceeds the active-turn row limit");
    }
    const first = inputs[0]!;
    this.verifyCheckpointChunkInputs(inputs, first);
    return this.preparedCheckpointChunk(inputs, first);
  }

  private verifyCheckpointChunkInputs(
    inputs: readonly ParentAssistantTextCheckpointInput[],
    first: ParentAssistantTextCheckpointInput,
  ): void {
    for (const [index, input] of inputs.entries()) {
      this.verifyCheckpointChunkInput(input, first, index);
    }
  }

  private verifyCheckpointChunkInput(
    input: ParentAssistantTextCheckpointInput,
    first: ParentAssistantTextCheckpointInput,
    index: number,
  ): void {
    if (input.executionId !== first.executionId || input.threadId !== first.threadId || input.turnId !== first.turnId) {
      throw new Error("Assistant text checkpoint chunk mixes execution routing");
    }
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new Error("Assistant text checkpoint sequence must be a positive safe integer");
    }
    if (input.sequence !== first.sequence + index) {
      throw new Error("Assistant text checkpoint chunk sequences must be consecutive");
    }
    if (Buffer.byteLength(input.text, "utf8") === 0) {
      throw new Error("Assistant text checkpoint delta must contain text");
    }
  }

  private preparedCheckpointChunk(
    inputs: readonly ParentAssistantTextCheckpointInput[],
    first: ParentAssistantTextCheckpointInput,
  ): PreparedParentAssistantTextCheckpointChunk {
    const text = inputs.map((input) => input.text).join("");
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
      throw new Error("Assistant text checkpoint chunk exceeds the active-turn byte limit");
    }
    return {
      executionId: first.executionId,
      threadId: first.threadId,
      turnId: first.turnId,
      firstSequence: first.sequence,
      lastSequence: inputs.at(-1)!.sequence,
      text,
      byteLength,
      itemCount: inputs.length,
    };
  }
}

/** One fsynced assistant-text chunk that can be imported into SQLite after recovery. */
export interface ParentAssistantTextRecoveryJournalChunk {
  executionId: string;
  threadId: string;
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  text: string;
  byteLength: number;
}

interface ParentAssistantTextRecoveryJournalRecord {
  version: 1;
  executionId: string;
  threadId: string;
  turnId: string;
  firstSequence: number;
  lastSequence: number;
  byteLength: number;
  textBase64: string;
  checksum: string;
}

/** Appends fsynced per-execution records outside SQLite's failure domain. */
export class ParentAssistantTextRecoveryJournal {
  constructor(private readonly directory?: string) {}

  /** Return whether this process can use a file-backed journal. */
  isAvailable(): boolean {
    return this.directory !== undefined;
  }

  /** Append a complete chunk and fsync it before the caller publishes the source text. */
  append(inputs: readonly ParentAssistantTextCheckpointInput[]): void {
    if (!this.directory) throw new Error("Assistant text recovery journal is unavailable");
    const record = createRecoveryJournalRecord(inputs);
    const path = this.pathFor(record.executionId);
    NodeFS.mkdirSync(this.directory, { recursive: true });
    const descriptor = NodeFS.openSync(path, "a", 0o600);
    try {
      const encoded = Buffer.from(JSON.stringify(record) + "\n", "utf8");
      let offset = 0;
      while (offset < encoded.length) {
        const written = NodeFS.writeSync(descriptor, encoded, offset, encoded.length - offset);
        if (written <= 0) throw new Error("Assistant text recovery journal write did not complete");
        offset += written;
      }
      NodeFS.fsyncSync(descriptor);
    } finally {
      NodeFS.closeSync(descriptor);
    }
  }

  /** Import one execution's complete records and remove the journal only after all imports commit. */
  drain(
    executionId: string,
    append: (input: ParentAssistantTextRecoveryJournalChunk) => unknown,
  ): boolean {
    if (!this.directory) return true;
    const path = this.pathFor(executionId);
    if (!NodeFS.existsSync(path)) return true;
    for (const record of this.readRecords(path, executionId)) {
      append(recoveryJournalChunk(record));
    }
    NodeFS.unlinkSync(path);
    return true;
  }

  /** Import every journal whose filename has a safe execution identity. */
  drainAll(append: (input: ParentAssistantTextRecoveryJournalChunk) => unknown): string[] {
    if (!this.directory || !NodeFS.existsSync(this.directory)) return [];
    const drained: string[] = [];
    for (const name of NodeFS.readdirSync(this.directory)) {
      if (!name.endsWith(".journal")) continue;
      const executionId = name.slice(0, -".journal".length);
      if (!isSafeExecutionId(executionId)) continue;
      this.drain(executionId, append);
      drained.push(executionId);
    }
    return drained;
  }

  /** Await every SQLite commit before removing the only fsynced copy of recovered text. */
  async drainAsync(executionId: string, append: (input: ParentAssistantTextRecoveryJournalChunk) => Promise<unknown>): Promise<boolean> {
    if (!this.directory) return true;
    const path = this.pathFor(executionId);
    if (!NodeFS.existsSync(path)) return true;
    for (const record of this.readRecords(path, executionId)) await append(recoveryJournalChunk(record));
    NodeFS.unlinkSync(path);
    return true;
  }

  /** Await recovery imports from every safely named execution journal. */
  async drainAllAsync(append: (input: ParentAssistantTextRecoveryJournalChunk) => Promise<unknown>): Promise<string[]> {
    if (!this.directory || !NodeFS.existsSync(this.directory)) return [];
    const drained: string[] = [];
    for (const name of NodeFS.readdirSync(this.directory)) {
      if (!name.endsWith(".journal")) continue;
      const executionId = name.slice(0, -".journal".length);
      if (!isSafeExecutionId(executionId)) continue;
      await this.drainAsync(executionId, append);
      drained.push(executionId);
    }
    return drained;
  }

  /** Remove one journal after the canonical terminal projection is verified. */
  discard(executionId: string): void {
    if (!this.directory || !isSafeExecutionId(executionId)) return;
    const path = this.pathFor(executionId);
    if (NodeFS.existsSync(path)) NodeFS.unlinkSync(path);
  }

  private pathFor(executionId: string): string {
    if (!this.directory || !isSafeExecutionId(executionId)) {
      throw new Error("Assistant text recovery journal execution identity is invalid");
    }
    return NodePath.join(this.directory, executionId + ".journal");
  }

  private readRecords(
    path: string,
    executionId: string,
  ): ParentAssistantTextRecoveryJournalRecord[] {
    if (NodeFS.statSync(path).size > PARENT_ASSISTANT_TEXT_RECOVERY_JOURNAL_MAX_BYTES) {
      throw new Error("Assistant text recovery journal exceeds its bounded retention");
    }
    const contents = NodeFS.readFileSync(path, "utf8");
    if (contents.length > 0 && !contents.endsWith("\n")) {
      throw new Error("Assistant text recovery journal has an incomplete final record");
    }
    const lines = contents.split("\n");
    const records: ParentAssistantTextRecoveryJournalRecord[] = [];
    let retainedBytes = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.length === 0 && index === lines.length - 1) continue;
      const parsed = JSON.parse(line) as unknown;
      const record = validateRecoveryJournalRecord(parsed, executionId);
      if (records.length === PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxChunks
        || retainedBytes + record.byteLength > PARENT_ASSISTANT_TEXT_RETAINED_LIMITS.maxBytes) {
        throw new Error("Assistant text recovery journal exceeds its bounded retention");
      }
      retainedBytes += record.byteLength;
      records.push(record);
    }
    return records;
  }
}

function resolveDefaultRecoveryJournalDirectory(db: Database): string | undefined {
  if (db.filename === ":memory:") return undefined;
  if (!db.filename) throw new Error("Assistant text recovery journal database path is unavailable");
  return NodePath.join(NodePath.dirname(db.filename), NodePath.basename(db.filename) + ".recovery", "parent-assistant-text");
}

function createRecoveryJournalRecord(
  inputs: readonly ParentAssistantTextCheckpointInput[],
): ParentAssistantTextRecoveryJournalRecord {
  if (inputs.length === 0) throw new Error("Assistant text recovery journal chunk must not be empty");
  const first = inputs[0]!;
  verifyJournalExecutionId(first.executionId);
  verifyRecoveryJournalInputs(inputs, first);
  return journalRecordFromInputs(inputs, first);
}

function verifyJournalExecutionId(executionId: string): void {
  if (!isSafeExecutionId(executionId)) {
    throw new Error("Assistant text recovery journal execution identity is invalid");
  }
}

function verifyRecoveryJournalInputs(
  inputs: readonly ParentAssistantTextCheckpointInput[],
  first: ParentAssistantTextCheckpointInput,
): void {
  for (const [index, input] of inputs.entries()) {
    verifyRecoveryJournalInput(input, first, index);
  }
}

function verifyRecoveryJournalInput(
  input: ParentAssistantTextCheckpointInput,
  first: ParentAssistantTextCheckpointInput,
  index: number,
): void {
  if (input.executionId !== first.executionId || input.threadId !== first.threadId || input.turnId !== first.turnId) {
    throw new Error("Assistant text recovery journal chunk mixes execution routing");
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence !== first.sequence + index) {
    throw new Error("Assistant text recovery journal chunk sequences must be consecutive");
  }
  if (Buffer.byteLength(input.text, "utf8") === 0) {
    throw new Error("Assistant text recovery journal delta must contain text");
  }
}

function journalRecordFromInputs(
  inputs: readonly ParentAssistantTextCheckpointInput[],
  first: ParentAssistantTextCheckpointInput,
): ParentAssistantTextRecoveryJournalRecord {
  const text = inputs.map((input) => input.text).join("");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) {
    throw new Error("Assistant text recovery journal chunk exceeds the active-turn byte limit");
  }
  const textBase64 = Buffer.from(text, "utf8").toString("base64");
  const record: Omit<ParentAssistantTextRecoveryJournalRecord, "checksum"> = {
    version: 1,
    executionId: first.executionId,
    threadId: first.threadId,
    turnId: first.turnId,
    firstSequence: first.sequence,
    lastSequence: inputs.at(-1)!.sequence,
    byteLength,
    textBase64,
  };
  return {
    ...record,
    checksum: recoveryJournalChecksum(record),
  };
}

function validateRecoveryJournalRecord(
  value: unknown,
  executionId: string,
): ParentAssistantTextRecoveryJournalRecord {
  const record = recoveryJournalRecordValue(value);
  if (!isValidRecoveryJournalRecord(record, executionId)) {
    throw new Error("Assistant text recovery journal record is invalid");
  }
  const verified: Omit<ParentAssistantTextRecoveryJournalRecord, "checksum"> = {
    version: 1,
    executionId: record.executionId,
    threadId: record.threadId,
    turnId: record.turnId,
    firstSequence: record.firstSequence!,
    lastSequence: record.lastSequence!,
    byteLength: record.byteLength!,
    textBase64: record.textBase64,
  };
  if (recoveryJournalChecksum(verified) !== record.checksum) {
    throw new Error("Assistant text recovery journal checksum conflicts");
  }
  const text = Buffer.from(record.textBase64, "base64").toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== record.byteLength) {
    throw new Error("Assistant text recovery journal byte length conflicts");
  }
  return { ...verified, checksum: record.checksum };
}

function recoveryJournalRecordValue(value: unknown): Partial<ParentAssistantTextRecoveryJournalRecord> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Partial<ParentAssistantTextRecoveryJournalRecord>;
}

function isValidRecoveryJournalRecord(
  record: Partial<ParentAssistantTextRecoveryJournalRecord> | null,
  executionId: string,
): record is ParentAssistantTextRecoveryJournalRecord {
  return record !== null
    && hasValidRecordIdentity(record, executionId)
    && hasValidRecordBounds(record)
    && hasValidRecordPayload(record);
}

function hasValidRecordIdentity(
  record: Partial<ParentAssistantTextRecoveryJournalRecord>,
  executionId: string,
): boolean {
  return record.version === 1
    && record.executionId === executionId
    && typeof record.threadId === "string"
    && typeof record.turnId === "string";
}

function hasValidRecordBounds(record: Partial<ParentAssistantTextRecoveryJournalRecord>): boolean {
  const firstSequence = positiveSafeInteger(record.firstSequence);
  const lastSequence = positiveSafeInteger(record.lastSequence);
  const byteLength = positiveSafeInteger(record.byteLength);
  if (firstSequence === null || lastSequence === null || byteLength === null) return false;
  if (lastSequence < firstSequence || byteLength > ACTIVE_TURN_WRITE_BATCH_LIMITS.maxBytes) return false;
  return lastSequence - firstSequence + 1 <= ACTIVE_TURN_WRITE_BATCH_LIMITS.maxRows - 1;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function hasValidRecordPayload(record: Partial<ParentAssistantTextRecoveryJournalRecord>): boolean {
  return typeof record.textBase64 === "string" && typeof record.checksum === "string";
}

function recoveryJournalChunk(
  record: ParentAssistantTextRecoveryJournalRecord,
): ParentAssistantTextRecoveryJournalChunk {
  return {
    executionId: record.executionId,
    threadId: record.threadId,
    turnId: record.turnId,
    firstSequence: record.firstSequence,
    lastSequence: record.lastSequence,
    text: Buffer.from(record.textBase64, "base64").toString("utf8"),
    byteLength: record.byteLength,
  };
}

function recoveryJournalChecksum(
  record: Omit<ParentAssistantTextRecoveryJournalRecord, "checksum">,
): string {
  return NodeCrypto.createHash("sha256").update([
    record.version,
    record.executionId,
    record.threadId,
    record.turnId,
    record.firstSequence,
    record.lastSequence,
    record.byteLength,
    record.textBase64,
  ].join("\n")).digest("hex");
}

function isSafeExecutionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
