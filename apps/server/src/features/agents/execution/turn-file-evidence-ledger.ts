import type { Database } from "bun:sqlite";
import type { z } from "zod";
import type { TurnFileEvidence } from "@mcode/contracts/models/turn-file-evidence";
import { logger } from "@mcode/shared";
import { broadcast } from "../../../application/transport/push.js";
import type { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import type { SnapshotService } from "../../projects/diffs/snapshots/snapshot-service.js";
import type { FrozenExecutionFileEvidence } from "./execution-file-evidence-coordinator.js";
import type { PreparedExecutionFileEvidence } from "../turns/turn-execution-file-evidence.js";
import { beginTurnFileEvidence, listTurnFileEvidence, recordTurnFileEvidence } from "../turns/persistence/turn-file-evidence-store.js";
import type { ExecutionIdentity } from "./execution-mailbox-protocol.js";

type Resolution = Omit<z.infer<typeof recordTurnFileEvidence.input>, keyof ExecutionIdentity>;

interface Entry {
  collected: Promise<void>;
  facts: Promise<PreparedExecutionFileEvidence | null>;
  tracked: (facts: PreparedExecutionFileEvidence | null) => void;
  write?: () => Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
  published: boolean;
  observed?: PreparedExecutionFileEvidence;
}

/** Separates terminal durability from bounded file collection and durable evidence retries. */
export class TurnFileEvidenceLedger {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(private readonly db: Database, private readonly writer: Pick<ApplicationDatabaseWriter, "execute">,
    private readonly snapshots: Pick<SnapshotService, "captureRef" | "compareTrees">,
    private readonly resolved: (execution: ExecutionIdentity) => void = () => {}) {}

  /** Insert the marker wherever tracking starts, with or without a baseline. */
  begin(execution: ExecutionIdentity): Promise<null> { return this.writer.execute(beginTurnFileEvidence, execution); }

  /** Resolve an early dispatch failure whose generation was never opened. */
  expectUnsent(execution: ExecutionIdentity, providerOriginated = false): void {
    if (this.entries.has(execution.executionId)) return;
    const entry: Entry = { collected: Promise.resolve(), facts: Promise.resolve(null), tracked: () => {}, attempts: 0, published: false };
    entry.write = () => this.persist(execution, entry, { evidence: providerOriginated
      ? { state: "unavailable", reason: "observation-lost", knownPaths: [] }
      : { state: "recorded", filesChanged: [] }, snapshot: null, diff: null });
    this.entries.set(execution.executionId, entry);
  }

  /** Start capture synchronously at seal, before another baseline can claim the Git lock. */
  expect(execution: ExecutionIdentity, frozen: FrozenExecutionFileEvidence): void {
    if (this.entries.has(execution.executionId)) return;
    const capture = frozen.handoff.baselineRef ? this.snapshots.captureRef(frozen.handoff.cwd).then(
      (ref) => ({ ref }), () => ({ ref: null }),
    ) : Promise.resolve({ ref: null });
    let tracked!: Entry["tracked"];
    const facts = new Promise<PreparedExecutionFileEvidence | null>((resolve) => { tracked = resolve; });
    const entry: Entry = { facts, tracked, collected: Promise.resolve(), attempts: 0, published: false };
    this.entries.set(execution.executionId, entry);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<TurnFileEvidence>((resolve) => {
      timer = setTimeout(() => {
        logger.warn("Turn file evidence collection timed out", execution);
        resolve({ state: "unavailable", reason: "timed-out", knownPaths: [...entry.observed?.filesChanged ?? []],
          ...(entry.observed?.fileEffects.fileCount ? { fileEffects: entry.observed.fileEffects } : {}) });
      }, 10_000);
    });
    const prepared = this.prepare(frozen, capture, facts);
    entry.collected = Promise.race([prepared, timeout.then((evidence) => ({ evidence, snapshot: null, diff: null }))]).then((result) => {
      clearTimeout(timer);
      entry.write = () => this.persist(execution, entry, result);
      void entry.write();
    });
  }

  /** Supply the worker's final tracked facts, or explicitly report a lost receipt. */
  tracked(execution: ExecutionIdentity, facts: PreparedExecutionFileEvidence | "lost" | null): void {
    const entry = this.entries.get(execution.executionId);
    if (!entry) return;
    if (facts && facts !== "lost") entry.observed ??= facts;
    entry.tracked(facts === "lost" ? null : facts);
  }

  /** Called only after turn.persisted was broadcast, including the accepted-save path. */
  terminalSaved(execution: ExecutionIdentity): void {
    const entry = this.entries.get(execution.executionId);
    // A lost worker or failed seal never registered an entry; its saved ending must still resolve the row.
    if (!entry) {
      void this.resolveReleased(execution).catch((error: unknown) => logger.warn("Turn file evidence resolution failed", { ...execution, error: String(error) }));
      return;
    }
    entry.published = true;
    try { this.publish(execution); } finally { void entry.write?.(); }
  }

  /** The next turn waits for collection, never for an unavailable database to recover. */
  async collected(execution: ExecutionIdentity): Promise<void> { await this.entries.get(execution.executionId)?.collected; }

  /** Resolve abandoned tracking without recapturing a workspace that may have moved on. */
  async resolveAbandoned(threadId?: string, reason: "restarted" | "observation-lost" = "observation-lost"): Promise<void> {
    for (const row of listTurnFileEvidence(this.db, { ...(threadId === undefined ? {} : { threadId }), tracking: true })) {
      if (this.entries.has(row.executionId)) continue;
      if (reason === "observation-lost") {
        await this.resolveReleased(row);
        continue;
      }
      const result = await this.writer.execute(recordTurnFileEvidence, { ...row,
        evidence: { state: "unavailable", reason, knownPaths: [] }, snapshot: null, diff: null });
      if (result === "resolved") { this.publish(row); this.resolved(row); }
    }
  }

  private async resolveReleased(execution: ExecutionIdentity): Promise<void> {
    const terminal = this.db.query<{ terminal_outcome: string | null }, [string]>(
      "SELECT terminal_outcome FROM canonical_agent_ingest_checkpoints WHERE execution_id = ?",
    ).get(execution.executionId);
    if (!terminal?.terminal_outcome) return;
    this.expectUnsent(execution, true);
    const entry = this.entries.get(execution.executionId);
    if (!entry) return;
    entry.published = true;
    await entry.write?.();
  }

  /** Drop an entry whose ending was never written; startup resolves its row if one exists. */
  forget(execution: ExecutionIdentity): void {
    clearTimeout(this.entries.get(execution.executionId)?.retry);
    this.entries.delete(execution.executionId);
  }

  /** Stop retry timers during server shutdown. */
  close(): void { this.closed = true; for (const entry of this.entries.values()) clearTimeout(entry.retry); }

  private async prepare(frozen: FrozenExecutionFileEvidence, capture: Promise<{ ref: string | null }>, facts: Entry["facts"]): Promise<Resolution> {
    const tracked = await facts;
    if (!tracked) return { evidence: { state: "unavailable", reason: "observation-lost", knownPaths: [] } satisfies TurnFileEvidence, snapshot: null, diff: null };
    const knownPaths = [...tracked.filesChanged];
    const fileEffects = tracked.fileEffects;
    const unavailable = () => ({ evidence: { state: "unavailable", reason: "capture-failed", knownPaths, fileEffects } satisfies TurnFileEvidence, snapshot: null, diff: tracked.selectedTurnDiff });
    const before = frozen.handoff.baselineRef;
    const after = (await capture).ref;
    if (before && !after) return unavailable();
    try {
      const filesChanged = await this.paths(frozen, knownPaths, after);
      const evidence: TurnFileEvidence = !before && !filesChanged.length ? { state: "untracked" } : { state: "recorded", filesChanged, fileEffects };
      return { evidence, snapshot: this.snapshot(tracked, evidence, before, after), diff: tracked.selectedTurnDiff };
    } catch { return unavailable(); }
  }

  private snapshot(tracked: PreparedExecutionFileEvidence, evidence: TurnFileEvidence, before: string | null, after: string | null): Resolution["snapshot"] {
    if (evidence.state !== "recorded") return null;
    if (tracked.fileEffects.fileCount === 0 && !(before && after)) return null;
    return { threadId: tracked.threadId, refBefore: before ?? "", refAfter: after ?? "", filesChanged: evidence.filesChanged,
      fileEffects: tracked.fileEffects, worktreePath: null };
  }

  private paths(frozen: FrozenExecutionFileEvidence, tracked: string[], after: string | null): Promise<string[]> {
    const before = frozen.handoff.baselineRef;
    return before && after && tracked.length === 0
      ? this.snapshots.compareTrees(frozen.handoff.cwd, before, after) : Promise.resolve(tracked);
  }

  private async persist(execution: ExecutionIdentity, entry: Entry, result: Resolution): Promise<void> {
    if (this.closed || !entry.published) return;
    try {
      const saved = await this.writer.execute(recordTurnFileEvidence, { ...execution, ...result });
      if (saved === "terminal-not-saved") return;
      this.publish(execution);
      this.resolved(execution);
      clearTimeout(entry.retry);
      this.entries.delete(execution.executionId);
    } catch (error) {
      logger.warn("Turn file evidence save failed; retrying", { ...execution, error: String(error) });
      clearTimeout(entry.retry);
      entry.retry = setTimeout(() => { void entry.write?.(); }, Math.min(60_000, 1000 * 2 ** Math.min(entry.attempts++, 6)));
      entry.retry.unref();
    }
  }

  private publish(execution: Pick<ExecutionIdentity, "threadId" | "executionId">): void {
    const [stored] = listTurnFileEvidence(this.db, { threadId: execution.threadId, executionId: execution.executionId });
    if (!stored) return;
    broadcast("turn.fileEvidence", stored);
    if (stored.evidence.state !== "tracking") broadcast("turn.diffChanged", { threadId: execution.threadId });
  }
}
