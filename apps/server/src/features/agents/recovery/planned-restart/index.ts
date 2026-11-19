import { inject, injectable } from "tsyringe";
import { logger } from "@mcode/shared";
import { PLANNED_RESTART_NOTICE_KEY_PREFIX, plannedRestartNoticeText } from "@mcode/shared/planned-restart";
import { turnAdmissionFailureReason } from "@mcode/shared/turn-admission";
import { CanonicalAgentBoundary } from "../../canonical/canonical-agent-boundary.js";
import { BackgroundCommandStore } from "../../background/background-command-store.js";
import { MessageRepo } from "../../conversation/persistence/message-repo.js";
import { TurnRecoveryService } from "../turn-recovery-service.js";
import { TurnRecoveryError, turnRecoveryErrorCode } from "../turn-recovery-error.js";
import type { StoppedBackgroundCall } from "../../turns/background-tool-settlement-effect.js";
import { PlannedRestartStore, type PlannedRestartRecord } from "./planned-restart-store.js";
import type { ContinuationAction, RecordedTurn } from "./continuation-action.js";

type TurnDispatch = Parameters<TurnRecoveryService["resumeTurn"]>[1];

function threadOf(action: ContinuationAction): string {
  return action.kind === "resume" ? action.turn.threadId : action.threadId;
}

/** Success and failure share a key so a fallback that fails after the success notice replaces it instead of contradicting it. */
function noticeKeyOf(action: ContinuationAction): string {
  return `${PLANNED_RESTART_NOTICE_KEY_PREFIX}${action.kind === "resume" ? action.turn.executionId : action.anchorTurnId}`;
}

/**
 * Run each step after the previous one, because the database writer admits a bounded queue, and run every step
 * even when one fails, so one failed warning cannot leave later threads pending.
 */
async function eachInTurn<T>(items: Iterable<T>, step: (item: T) => Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  for (const item of items) await step(item).catch((error: unknown) => { failures.push(error); });
  if (failures.length > 0) throw new AggregateError(failures, "Could not record background restart warnings");
}

/** The continuation's own message is hidden, so this tells the user why the agent started working. */
function startedNotice(action: ContinuationAction): string {
  return plannedRestartNoticeText(action.kind, "started");
}

/** Continues work interrupted by an intentional application stop. */
@injectable()
export class PlannedRestart {
  private readonly store = new PlannedRestartStore();
  private loaded = false;
  private stopping = false;
  private stoppedAt: string | undefined;
  private readonly pending = new Map<string, ContinuationAction>();
  /** The first attempt a continuation admitted, by thread; it can end before the seeded fallback admits. */
  private readonly attempts = new Map<string, string>();
  private readonly releaseListeners = new Set<(threadId: string) => void>();
  private readonly noticeListeners = new Set<(threadId: string) => void>();

  constructor(
    @inject(CanonicalAgentBoundary) private readonly canonical: CanonicalAgentBoundary,
    @inject(TurnRecoveryService) private readonly recovery: Pick<TurnRecoveryService, "resumeTurn" | "wakeParent">,
    @inject(MessageRepo) private readonly messages: MessageRepo,
    @inject(BackgroundCommandStore) private readonly commands?: Pick<BackgroundCommandStore, "noteRestartOrphans">,
  ) {}

  /** Prevent further continuation admissions; turns this stop interrupts end after this moment. */
  beginShutdown(): void {
    this.stopping = true;
    this.stoppedAt = new Date().toISOString();
  }

  /** Mark the stop before draining: startup decides from the final saved state. */
  async record(): Promise<void> {
    this.store.record({ version: 1, stoppedAt: this.stoppedAt ?? new Date().toISOString(), ...this.unfinished() });
  }

  /**
   * Rebuild pending work before coordinator recovery, retaining it until dispatch can start. Runs before held
   * background calls are settled, so the rewritten file keeps their wakes if this start exits early.
   */
  load(held: readonly StoppedBackgroundCall[] = []): void {
    if (this.loaded) return;
    this.loaded = true;
    const saved = this.store.read();
    if (!saved) return;
    const interrupted = saved.stoppedAt === undefined ? [] : this.canonical.listTurnsInterruptedByStop(saved.stoppedAt);
    for (const turn of [...interrupted, ...saved.resumes]) {
      this.add({ kind: "resume", turn });
    }
    for (const wake of saved.wakes) this.add({ kind: "wake", ...wake });
    for (const call of held) this.addHeldWake(call);
    this.store.record({ version: 1, ...this.unfinished() });
  }

  private addHeldWake(call: StoppedBackgroundCall): void {
    if (!this.pending.has(call.threadId)) {
      const latest = this.canonical.loadLatestTurn(call.threadId);
      if (latest) this.add({ kind: "wake", threadId: call.threadId, anchorTurnId: latest.id });
    }
    const wake = this.pending.get(call.threadId);
    if (wake?.kind !== "wake" || call.kind !== "command") return;
    const ids = wake.commandIds ??= [];
    if (!ids.includes(call.toolCallId)) ids.push(call.toolCallId);
  }

  private add(action: ContinuationAction): void {
    const threadId = threadOf(action);
    if (this.pending.has(threadId)) return;
    if (this.valid(action) || (action.kind === "wake" && action.commandIds?.length)) this.pending.set(threadId, action);
  }

  private unfinished(): Pick<PlannedRestartRecord, "resumes" | "wakes"> {
    const resumes: RecordedTurn[] = [];
    const wakes: PlannedRestartRecord["wakes"] = [];
    for (const action of this.pending.values()) {
      if (action.kind === "resume") resumes.push(action.turn);
      else {
        const { threadId, anchorTurnId, commandIds } = action;
        wakes.push({ threadId, anchorTurnId, commandIds });
      }
    }
    return { resumes, wakes };
  }

  /** Whether this stop or start owns the interrupted turn, or the native attempt still resuming it. */
  hasPendingResume(threadId: string, turnId: string): boolean {
    const action = this.pending.get(threadId);
    if (action?.kind === "resume" && (action.turn.turnId === turnId || this.attempts.get(threadId) === turnId)) return true;
    return this.stoppedAt !== undefined && this.interruptedByThisStop(threadId, turnId, this.stoppedAt);
  }

  /** Turns a started process still owes a resume: each pending resume's interrupted turn and its native attempt. */
  pendingResumeTurnIds(): ReadonlySet<string> {
    const turnIds = new Set<string>();
    for (const [threadId, action] of this.pending) {
      if (action.kind !== "resume") continue;
      turnIds.add(action.turn.turnId);
      const attempt = this.attempts.get(threadId);
      if (attempt) turnIds.add(attempt);
    }
    return turnIds;
  }

  private interruptedByThisStop(threadId: string, turnId: string, stoppedAt: string): boolean {
    const turn = this.canonical.loadTurn(turnId);
    return turn?.threadId === threadId && turn.status === "Interrupted" && turn.ending?.outcome === "interrupted"
      && turn.ending.cause === "app_closed" && turn.endedAt !== null && turn.endedAt !== undefined && turn.endedAt >= stoppedAt;
  }

  /** Hold coordinator wakes until their planned continuation is resolved. */
  isPending(threadId: string): boolean { return this.pending.has(threadId); }

  /** Whether the pending continuation is a wake anchored to a completed turn. */
  hasPendingWake(threadId: string): boolean { return this.pending.get(threadId)?.kind === "wake"; }

  /** Drop work cancelled by the user. */
  async cancel(threadId: string): Promise<void> { await this.releaseWithoutNotice(threadId); }

  /** Observe admissions and drops. */
  onReleased(listener: (threadId: string) => void): () => void {
    this.releaseListeners.add(listener);
    return () => { this.releaseListeners.delete(listener); };
  }

  /** Observe each written notice; a failure notice changes the thread's attention. */
  onNoticeWritten(listener: (threadId: string) => void): () => void {
    this.noticeListeners.add(listener);
    return () => { this.noticeListeners.delete(listener); };
  }

  /** Await every dispatch, with at most four continuations in flight. */
  async continueAtStartup(dispatch: TurnDispatch): Promise<void> {
    this.load();
    if (!this.store.clear()) {
      // The next start would read the file again and repeat whatever fails here, and a continuation is never retried.
      await eachInTurn(this.pending.keys(), (threadId) => this.releaseWithoutNotice(threadId));
      return;
    }
    const queue = [...this.pending.values()];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (!this.stopping) {
        const action = queue.shift();
        if (!action) return;
        await this.runAction(action, dispatch);
      }
    }));
    if (this.stopping) await eachInTurn(this.pending.values(), (action) => this.warnStoppedCommands(action));
  }

  private valid(action: ContinuationAction): boolean {
    const threadId = threadOf(action);
    const latest = this.canonical.loadLatestTurn(threadId);
    const turnId = action.kind === "resume" ? action.turn.turnId : action.anchorTurnId;
    if (!latest || latest.id !== turnId) return false;
    const state = this.canonical.loadTurnRetryState(threadId, turnId);
    if (state.hasRunningTurn || state.hasLaterTurn) return false;
    if (action.kind === "wake") return latest.status === "Completed";
    return this.canResume(action.turn, latest);
  }

  private canResume(turn: RecordedTurn, latest: NonNullable<ReturnType<CanonicalAgentBoundary["loadLatestTurn"]>>): boolean {
    return latest.executionId === turn.executionId && latest.status === "Interrupted"
      && latest.ending?.outcome === "interrupted" && latest.ending.cause === "app_closed";
  }

  private async runAction(action: ContinuationAction, dispatch: TurnDispatch): Promise<void> {
    const threadId = threadOf(action);
    if (!this.pending.has(threadId)) return;
    if (!this.valid(action)) { await this.releaseWithoutNotice(threadId); return; }
    let admitted = false;
    let nativeTurnId: string | undefined;
    const guarded: TurnDispatch = (command) => dispatch({ ...command, admissionGuard: () => {
      this.guardAdmission(action, admitted, nativeTurnId);
      if (!admitted) {
        nativeTurnId = command.sourceTurnId;
        if (nativeTurnId) this.attempts.set(threadId, nativeTurnId);
      }
      admitted = true;
    } });
    const failure = plannedRestartNoticeText(action.kind, "failed");
    const report = this.reporter(threadId, noticeKeyOf(action));
    let noticeWritten = false;
    const context = { onLateFailure: (error: unknown) => {
      if (this.lostRace(error)) return;
      logger.warn(failure, { threadId, error: String(error) });
      void report.failure(failure);
    } };
    try {
      if (action.kind === "resume") await this.recovery.resumeTurn(action.turn, guarded, context);
      else await this.recovery.wakeParent(action, guarded, context);
      noticeWritten = await report.success(startedNotice(action));
    } catch (error) {
      // Shutdown already listed this unadmitted work for the next start, so it stays pending rather than failing.
      if (this.stopping && !admitted) return;
      if (this.shouldReport(action, error, admitted)) {
        logger.warn(failure, { threadId, error: String(error) });
        noticeWritten = await report.failure(failure);
      }
    }
    if (noticeWritten) this.release(threadId);
    else await this.releaseWithoutNotice(threadId);
  }

  private guardAdmission(action: ContinuationAction, admitted: boolean, nativeTurnId: string | undefined): void {
    if (this.stopping) throw new Error("Mcode is shutting down");
    const threadId = threadOf(action);
    const valid = admitted ? this.canAdmitFallback(threadId, nativeTurnId)
      : this.pending.has(threadId) && this.valid(action);
    if (!valid) throw new TurnRecoveryError("TURN_RECOVERY_CONFLICT", "The thread changed before Mcode could continue it");
  }

  private canAdmitFallback(threadId: string, nativeTurnId: string | undefined): boolean {
    if (!nativeTurnId || this.canonical.loadLatestTurn(threadId)?.id !== nativeTurnId) return false;
    const state = this.canonical.loadTurnRetryState(threadId, nativeTurnId);
    return !state.hasRunningTurn && !state.hasLaterTurn;
  }

  private shouldReport(action: ContinuationAction, error: unknown, admitted: boolean): boolean {
    return this.pending.has(threadOf(action)) && !this.lostRace(error) && (admitted || this.valid(action));
  }

  private lostRace(error: unknown): boolean {
    return turnRecoveryErrorCode(error) === "TURN_RECOVERY_CONFLICT" || turnAdmissionFailureReason(error) === "busy";
  }

  /**
   * A fallback can fail before or after the success notice is written. Writes run in call order and a failure
   * suppresses any later success, so the failure is always the notice left under the shared key.
   */
  private reporter(threadId: string, noticeKey: string): { success(content: string): Promise<boolean>; failure(content: string): Promise<boolean> } {
    let written = Promise.resolve(false);
    let failed = false;
    const write = (content: string) => (written = written.then(() => this.notice(threadId, content, noticeKey)));
    return {
      success: (content) => (failed ? written : write(content)),
      failure: (content) => { failed = true; return write(content); },
    };
  }

  /**
   * A late failure replaces the success notice and moves after the attempt's output, so it reads where it
   * happened and stays newer than the last turn for attention. The publication reaches an open thread live.
   */
  private async notice(threadId: string, content: string, noticeKey: string): Promise<boolean> {
    const systemNotice = { kind: "diagnostic", presentation: "timeline", noticeKey } as const;
    let written: { id: string; sequence: number };
    try {
      written = await this.messages.replaceKeyedSystemNotice(threadId, content, systemNotice);
    } catch (error) {
      logger.error("Planned restart notice was not written", { threadId, error: String(error) });
      return false;
    }
    for (const listener of this.noticeListeners) listener(threadId);
    try {
      this.canonical.recordSynthesizedPublications(threadId, [{ type: "system", threadId, subtype: "planned-restart.notice",
        message: content, messageId: written.id, sequence: written.sequence, systemNotice }]);
    } catch (error) {
      // The notice is saved, so a client that missed this publication still reads it on its next load.
      logger.error("Planned restart notice was not published", { threadId, error: String(error) });
    }
    return true;
  }

  private release(threadId: string): void {
    this.attempts.delete(threadId);
    if (!this.pending.delete(threadId)) return;
    for (const listener of this.releaseListeners) listener(threadId);
  }

  private async releaseWithoutNotice(threadId: string): Promise<void> {
    const action = this.pending.get(threadId);
    try {
      if (action) await this.warnStoppedCommands(action);
    } finally {
      this.release(threadId);
    }
  }

  private async warnStoppedCommands(action: ContinuationAction): Promise<void> {
    if (action.kind === "wake" && action.commandIds?.length) {
      await this.commands?.noteRestartOrphans(action.threadId, action.commandIds);
    }
  }
}
