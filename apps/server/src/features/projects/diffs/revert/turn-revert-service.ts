import * as NodeCrypto from "node:crypto";
import * as NodeFSPromises from "node:fs/promises";
import type { TurnRevertResult, TurnRevertPreview } from "@mcode/contracts";
import type { ApplicationDatabaseWriter } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { TurnRevertStore, type StoredRevert } from "../../../agents/turns/persistence/turn-revert-store.js";
import { prepareTurnRevert, settleTurnRevert } from "../../../agents/turns/persistence/turn-revert-write-operations.js";
import type { RepositoryGitMutationLock } from "../../git/repository-git-mutation-lock.js";
import { ReviewWorktreeMissingError } from "../../git/review-comparison-errors.js";
import type { StoreId } from "../snapshots/snapshot-store-identity.js";
import { removeRawTemps, samePathState, type RawPathState } from "../snapshots/snapshot-raw-state.js";
import { classifyRecovery, TurnRevertValidationError, type RecoveryPath } from "./turn-revert-model.js";
import { preparePreview, revertRange, type RevertPreviewDeps, type RevertPreviewInput } from "./turn-revert-preview.js";

/** Test-only failure points cover prepare, individual writes, and the atomic commit. */
export type RevertFaultPoint = "captureRaw" | "planCheckout" | "pinRecovery" | "afterPrepare" | "afterWrite" | "commit";
/** A simulated process death deliberately bypasses rollback. */
export class TurnRevertFaultStop extends Error {}
/** Runtime dependencies; the database reader cannot mutate the journal. */
export interface TurnRevertDeps extends RevertPreviewDeps {
  store: TurnRevertStore;
  writer: Pick<ApplicationDatabaseWriter, "execute">;
  lock: RepositoryGitMutationLock;
  storeId: StoreId;
  publish(result: Extract<TurnRevertResult, { status: "reverted" }>): void;
}
/** One user click has an identity independent of its worktree precondition. */
export interface RevertApplyInput extends RevertPreviewInput { requestId: string; previewToken: string }
/** Undo targets a forward operation, never a snapshot. */
export interface RevertUndoInput { threadId: string; revertId: string; requestId: string }

/** Durable worktree-only restore operations, serialized with turn baseline capture. */
export class TurnRevertService {
  private readonly inFlight = new Map<string, { requestId: string; callers: number }>();
  constructor(private readonly deps: TurnRevertDeps,
    private readonly fault?: (point: RevertFaultPoint, writes: number) => void | Promise<void>) {}

  /** Preview without changing files, refs, or journal rows. */
  async preview(input: RevertPreviewInput): Promise<TurnRevertPreview> {
    const cwd = await this.cwd(input);
    if (cwd === null) return { status: "unavailable", reason: "worktree_missing" };
    if (this.inFlight.has(cwd)) return { status: "busy", reason: "revert_running" };
    return (await preparePreview(this.deps, input)).preview;
  }

  /** Apply once per request id and reject stale raw evidence under the repository lock. */
  async apply(input: RevertApplyInput): Promise<TurnRevertResult> {
    const recorded = this.deps.store.byRequest(input.requestId);
    const cwd = recorded ? recorded.context.cwd : await this.cwd(input);
    if (cwd === null) return { status: "unavailable", reason: "worktree_missing" };
    return this.run(cwd, input.requestId, async () => {
      const request = applyRequestKey(input);
      const replay = await this.replay(input.requestId, request);
      if (replay) return replay;
      const evidence = await preparePreview(this.deps, input);
      const { preview, range } = evidence;
      if (preview.status === "busy" || preview.status === "unavailable") return preview;
      if (preview.status !== "ready" || preview.previewToken !== input.previewToken || !range) return { status: "stale", preview };
      const files = preview.files.filter((file) => file.state !== "already_reverted");
      if (!files.length) return { status: "stale", preview: { status: "nothing_to_revert" } };
      return this.prepareAndWrite({ input, cwd, request, files, refBefore: range.refBefore, snapshotIds: range.rows.map((row) => row.id) });
    });
  }

  /** Undo writes the original pre-state exactly, only while the forward state is still present. */
  async undo(input: RevertUndoInput): Promise<TurnRevertResult> {
    const target = this.deps.store.get(input.revertId);
    if (!target || target.threadId !== input.threadId) throw new TurnRevertValidationError("Revert not found in thread");
    return this.run(target.context.cwd, input.requestId, async () => {
      const request = JSON.stringify(["undo", input.threadId, input.revertId]);
      const replay = await this.replay(input.requestId, request);
      if (replay) return replay;
      const row = this.deps.store.get(input.revertId);
      if (!row || !await this.canUndo(row)) return { status: "unavailable", reason: "recovery_expired" };
      if (await this.deps.busy(row.context.cwd)) return { status: "busy", reason: "turn_running" };
      const current = await this.deps.snapshots.workingTreeState(row.context.cwd, row.files.map((file) => file.path));
      if (row.files.some((file) => !file.planned || !samePathState(requiredState(current, file.path), file.planned))) {
        return { status: "stale", preview: (await preparePreview(this.deps, targetInput(row))).preview };
      }
      const id: string = NodeCrypto.randomUUID();
      try {
        await this.fault?.("pinRecovery", 0);
        const files = row.files.map((file) => ({ ...file, pre: requiredPlanned(file), planned: file.pre }));
        const recoveryRef = await this.deps.snapshots.pinRecovery(row.context.cwd, this.deps.storeId, id, files.flatMap((file) => [file.pre, file.planned]));
        await this.deps.writer.execute(prepareTurnRevert, { id, requestId: input.requestId, threadId: row.threadId,
          targetMessageId: row.targetMessageId, fromMessageId: row.fromMessageId, kind: "undo", path: row.path, undoesRevertId: row.id,
          context: { ...row.context, request }, files, recoveryRef });
      } catch (error) { return unchanged(error); }
      return this.write(id);
    });
  }

  /** Settle every unfinished journal before RPC admission. */
  async recoverUnfinished(): Promise<void> {
    for (const row of this.deps.store.unfinished()) await this.deps.lock.run(row.context.cwd, () => this.recover(row));
  }

  private async canUndo(row: StoredRevert): Promise<boolean> {
    if (row.state !== "committed" || row.kind === "undo" || row.undoneByRevertId || !row.recoveryRef) return false;
    return this.deps.snapshots.validateRef(row.context.cwd, row.recoveryRef);
  }

  private async cwd(input: RevertPreviewInput): Promise<string | null> {
    const range = revertRange(this.deps.ranges, input);
    let location: string;
    try { location = this.deps.resolveCwd(input.threadId, range.status === "ready" ? range.rows[0].worktree_path : null); }
    catch (error) { if (error instanceof ReviewWorktreeMissingError) return null; throw error; }
    try { return await NodeFSPromises.realpath(location); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return location; throw error; }
  }

  private async run(cwd: string, requestId: string, work: () => Promise<TurnRevertResult>): Promise<TurnRevertResult> {
    const active = this.inFlight.get(cwd);
    if (active && active.requestId !== requestId) return { status: "busy", reason: "revert_running" };
    const admission = active ?? { requestId, callers: 0 };
    admission.callers++;
    this.inFlight.set(cwd, admission);
    try { return await this.deps.lock.run(cwd, work); }
    finally { if (--admission.callers === 0) this.inFlight.delete(cwd); }
  }

  private async replay(requestId: string, request: string): Promise<TurnRevertResult | null> {
    let row = this.deps.store.byRequest(requestId);
    if (!row) return null;
    if (row.context.request !== request) throw new TurnRevertValidationError("requestId is already bound to different revert parameters");
    if (row.state === "prepared") { await this.recover(row); row = this.requiredRow(row.id); }
    return this.deps.store.outcome(row);
  }

  private async prepareAndWrite(args: {
    input: RevertApplyInput; cwd: string; request: string; files: Extract<TurnRevertPreview, { status: "ready" }>["files"];
    refBefore: string; snapshotIds: string[];
  }): Promise<TurnRevertResult> {
    const { input, cwd } = args;
    const id = NodeCrypto.randomUUID();
    try {
      const paths = args.files.map((file) => file.path);
      await this.fault?.("captureRaw", 0);
      const pre = await this.deps.snapshots.captureRaw(cwd, paths);
      await this.fault?.("planCheckout", 0);
      const planned = await this.deps.snapshots.planCheckout(cwd, args.refBefore, id, paths);
      const before = await this.deps.snapshots.blobIdsAt(cwd, args.refBefore, paths);
      const files = args.files.map((file) => ({ path: file.path, previousPath: file.previousPath, action: file.action,
        beforeBlob: before.get(file.path)?.blob ?? null, pre: requiredState(pre, file.path), planned: requiredState(planned, file.path) }));
      await this.fault?.("pinRecovery", 0);
      const recoveryRef = await this.deps.snapshots.pinRecovery(cwd, this.deps.storeId, id, files.flatMap((file) => [file.pre, file.planned]));
      const label = this.label(input);
      await this.deps.writer.execute(prepareTurnRevert, { id, requestId: input.requestId, threadId: input.threadId,
        targetMessageId: input.messageId, fromMessageId: input.scope.kind === "file" ? input.scope.fromMessageId ?? null : null,
        kind: input.scope.kind, path: input.scope.kind === "file" ? input.scope.path : null, undoesRevertId: null,
        context: { request: args.request, cwd, snapshotIds: args.snapshotIds, label }, files, recoveryRef });
    } catch (error) { return unchanged(error); }
    return this.write(id);
  }

  private label(input: RevertPreviewInput): string {
    const turns = this.deps.ranges.listTurns(input.threadId);
    const end = turns.find((turn) => turn.messageIds.includes(input.messageId))?.ordinal;
    const startId = input.scope.kind === "file" ? input.scope.fromMessageId : undefined;
    const start = startId ? turns.find((turn) => turn.messageIds.includes(startId))?.ordinal : undefined;
    const turn = start && start !== end ? `Turns ${start}–${end}` : `Turn ${end}`;
    return input.scope.kind === "file" ? `${input.scope.path} · ${turn}` : turn;
  }

  private requiredRow(id: string): StoredRevert {
    const row = this.deps.store.get(id);
    if (!row) throw new Error("Revert journal disappeared");
    return row;
  }

  private async write(id: string): Promise<TurnRevertResult> {
    const row = this.requiredRow(id);
    try {
      await this.fault?.("afterPrepare", 0);
      let writes = 0;
      await this.deps.snapshots.restoreRaw(row.context.cwd, id, row.files.map((file) => ({ path: file.path, state: requiredPlanned(file) })), async () => {
        await this.fault?.("afterWrite", ++writes);
      });
      const current = await this.deps.snapshots.workingTreeState(row.context.cwd, row.files.map((file) => file.path));
      if (row.files.some((file) => !samePathState(requiredState(current, file.path), requiredPlanned(file)))) throw new Error("Worktree changed during revert");
      await this.commit(row, writes);
    } catch (error) {
      if (error instanceof TurnRevertFaultStop) throw error;
      // A lost writer response may follow a successful commit. Never roll that operation back.
      const durable = this.requiredRow(id);
      if (durable.state !== "committed") await this.recover(durable, { kind: "runtime", detail: errorDetail(error) });
    }
    const result = this.deps.store.outcome(this.requiredRow(id));
    if (result.status === "reverted") this.deps.publish(result);
    return result;
  }

  private async commit(row: StoredRevert, writes: number): Promise<void> {
    let failCommit = false;
    try { await this.fault?.("commit", writes); }
    catch (error) { if (error instanceof TurnRevertFaultStop) throw error; failCommit = true; }
    const content = `${row.kind === "undo" ? "Undid revert of" : "Reverted"} ${row.context.label}${row.kind === "turn" ? ` · ${row.files.length} files` : ""}`;
    await this.deps.writer.execute(settleTurnRevert, { id: row.id, state: "committed", content, failure: null, failCommit });
  }

  private async recover(row: StoredRevert, failure: { kind: "runtime" | "interrupted"; detail: string } = { kind: "interrupted", detail: "Revert interrupted" }): Promise<void> {
    let detail = failure.detail;
    const cwd = row.context.cwd;
    const failed = new Set<string>();
    const restore: RecoveryPath[] = [];
    const available = await this.recoveryAvailable(row);
    for (const entry of row.files) {
      const decision = await this.recoveryDecision(row, entry, available);
      if (decision.kind === "equal_planned") restore.push(entry);
      else if (decision.kind !== "equal_pre") failed.add(entry.path);
    }
    // A failed ancestor must not be removed to restore a child, or vice versa.
    const safe = restore.filter((entry) => ![...failed].some((name) => entry.path.startsWith(`${name}/`) || name.startsWith(`${entry.path}/`)));
    try { await this.deps.snapshots.restoreRaw(cwd, row.id, safe.map((entry) => ({ path: entry.path, state: entry.pre }))); }
    catch (error) { detail = `${detail}: ${errorDetail(error)}`.slice(0, 500); }
    for (const entry of row.files) {
      if (!await this.matchesPre(cwd, entry)) failed.add(entry.path);
    }
    const paths = [...failed];
    await this.deps.writer.execute(settleTurnRevert, { id: row.id, state: paths.length ? "recovery_failed" : "rolled_back",
      failure: { paths, detail }, content: failure.kind === "runtime" ? null : interruptedReceipt(row, paths) });
  }

  private async recoveryAvailable(row: StoredRevert): Promise<boolean> {
    try { return row.recoveryRef !== null && await this.deps.snapshots.validateRef(row.context.cwd, row.recoveryRef); }
    catch { return false; }
  }

  private async recoveryDecision(row: StoredRevert, entry: RecoveryPath, available: boolean) {
    try {
      await removeRawTemps(row.context.cwd, row.id, [entry.path]);
      const current = requiredState(await this.deps.snapshots.workingTreeState(row.context.cwd, [entry.path]), entry.path);
      const material = available && (!entry.pre.rawBlob || await this.deps.snapshots.validateRef(row.context.cwd, entry.pre.rawBlob));
      return classifyRecovery(current, entry, material);
    } catch { return { kind: "not_provable" } satisfies import("./turn-revert-model.js").RecoveryDecision; }
  }

  private async matchesPre(cwd: string, entry: RecoveryPath): Promise<boolean> {
    try { return samePathState(requiredState(await this.deps.snapshots.workingTreeState(cwd, [entry.path]), entry.path), entry.pre); }
    catch { return false; }
  }
}

function interruptedReceipt(row: StoredRevert, paths: string[]): string {
  const outcome = paths.length ? `${paths.length} files could not be put back: ${paths.join(", ")}` : "Files were put back.";
  return `Revert of ${row.context.label} was interrupted. ${outcome}`;
}

function applyRequestKey(input: RevertApplyInput): string {
  const file = input.scope.kind === "file" ? input.scope : null;
  return JSON.stringify(["apply", input.threadId, input.messageId, input.scope.kind, file?.path ?? null, file?.fromMessageId ?? null, input.previewToken]);
}

function targetInput(row: StoredRevert): RevertPreviewInput {
  return { threadId: row.threadId, messageId: row.targetMessageId, scope: row.path
    ? { kind: "file", path: row.path, ...(row.fromMessageId ? { fromMessageId: row.fromMessageId } : {}) } : { kind: "turn" } };
}

function requiredState(states: Map<string, RawPathState>, name: string): RawPathState {
  const state = states.get(name);
  if (!state) throw new Error("Missing recorded path state");
  return state;
}

function requiredPlanned(file: RecoveryPath): RawPathState {
  if (!file.planned) throw new Error("Missing planned path state");
  return file.planned;
}

function errorDetail(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
function unchanged(error: unknown): TurnRevertResult {
  if (error instanceof TurnRevertFaultStop) throw error;
  return { status: "failed", outcome: "unchanged", paths: [], detail: errorDetail(error) };
}
