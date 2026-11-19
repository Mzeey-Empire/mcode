import { inject, injectable } from "tsyringe";
import type { ProviderBackgroundToolSettlement } from "@mcode/providers";
import type { IAgentProvider } from "@mcode/contracts/providers/interfaces";
import { CanonicalAgentBoundary } from "../canonical/canonical-agent-boundary.js";
import type { CanonicalAcceptedProgress } from "../canonical/canonical-accepted-progress.js";
import { ORPHANED_BACKGROUND_TOOL_OUTPUT } from "@mcode/shared/planned-restart";
import type { BackgroundCommandStore } from "../background/background-command-store.js";
import { TURN_FEATURE_EFFECTS, type TurnFeatureEffects } from "./turn-feature-effects.js";

/** A held background call stopped because its provider did not survive startup. */
export type StoppedBackgroundCall = ReturnType<CanonicalAgentBoundary["listHeldBackgroundToolCalls"]>[number];

type RestartWarnings = Pick<BackgroundCommandStore, "noteRestartOrphans">;

/** Settles background tool calls against the finished turn that launched them. */
@injectable()
export class BackgroundToolSettlementEffect {
  private acceptedProgress: Pick<CanonicalAcceptedProgress, "acceptLateToolResult" | "waitForSaved"> | undefined;
  private shutdownCommands: Map<string, Set<string>> | undefined;
  private shutdownNotes: Promise<void> = Promise.resolve();
  private progressClosing = false;

  constructor(
    @inject(CanonicalAgentBoundary) private readonly canonical: Pick<CanonicalAgentBoundary, "listHeldBackgroundToolCalls">,
    @inject(TURN_FEATURE_EFFECTS) private readonly featureEffects: Pick<TurnFeatureEffects, "subagentToolChanged">,
  ) {}

  /** Compose accepted admission independently of the terminal save acknowledgement. */
  bindAcceptedProgress(progress: NonNullable<BackgroundToolSettlementEffect["acceptedProgress"]>): void {
    this.acceptedProgress = progress;
  }

  /** Admit the late result immediately against its launching execution. */
  settle(settlement: Omit<ProviderBackgroundToolSettlement, "providerId">): void {
    const progress = this.progress();
    const { threadId, executionId, toolCallId, status, output } = settlement;
    progress.acceptLateToolResult(threadId, executionId, { toolCallId, status, output });
    this.featureEffects.subagentToolChanged(threadId, toolCallId);
  }

  /** Request a native stop, or settle an orphan against the execution that launched it. */
  async stopCommand(
    commands: Pick<BackgroundCommandStore, "runningLaunch">,
    threadId: string,
    toolCallId: string,
    stopTask: IAgentProvider["stopBackgroundTask"],
  ): Promise<"stopped" | "not-running"> {
    const launch = commands.runningLaunch(threadId, toolCallId);
    if (!launch) return "not-running";
    if (stopTask && launch.taskId !== null) {
      const outcome = await stopTask(`mcode-${threadId}`, launch.taskId);
      if (outcome === "stopped") return "stopped";
      if (outcome === "settling") throw new Error("The command's final state is not confirmed yet. Try Stop again in a moment.");
    }

    // A notification can be accepted already while its running row is still visible in SQLite.
    const progress = this.progress();
    await progress.waitForSaved(threadId);
    const remaining = commands.runningLaunch(threadId, toolCallId);
    if (remaining?.held) {
      this.settle({ threadId, toolCallId, executionId: remaining.executionId, status: "cancelled", output: "The provider task is no longer running." });
      await progress.waitForSaved(threadId);
    }
    return "not-running";
  }

  /**
   * Stop every background call still held after a restart. No provider process survives
   * one, so no late result can arrive for these calls.
   */
  async settleOrphansAtStartup(
    commands: RestartWarnings,
    hasPendingWake: (threadId: string) => boolean = () => false,
  ): Promise<StoppedBackgroundCall[]> {
    const progress = this.progress();
    const held = this.canonical.listHeldBackgroundToolCalls();
    const byThread = new Map<string, StoppedBackgroundCall[]>();
    for (const call of held) {
      const calls = byThread.get(call.threadId);
      if (calls) calls.push(call);
      else byThread.set(call.threadId, [call]);
    }
    for (const [threadId, calls] of byThread) {
      const commandIds = calls.filter(({ kind }) => kind === "command").map(({ toolCallId }) => toolCallId);
      if (commandIds.length > 0 && !hasPendingWake(threadId)) await commands.noteRestartOrphans(threadId, commandIds);
      for (const call of calls) this.settle({ ...call, status: "cancelled", output: ORPHANED_BACKGROUND_TOOL_OUTPUT });
      // The accepted writer bounds its in-memory threads, so drain this one before opening another.
      await progress.waitForSaved(threadId);
    }
    return held;
  }

  /** Start collecting the cancellations reported by provider teardown. */
  beginShutdown(): void {
    this.shutdownCommands = new Map();
  }

  /** Add the commands a provider cancelled when its session ended. */
  recordStoppedCommands(threadId: string, toolCallIds: readonly string[]): void {
    if (!this.shutdownCommands || toolCallIds.length === 0) return;
    const stopped = this.shutdownCommands.get(threadId) ?? new Set<string>();
    for (const toolCallId of toolCallIds) stopped.add(toolCallId);
    this.shutdownCommands.set(threadId, stopped);
  }

  /** Call before accepted progress closes: it then saves nothing more, so a later wait on it would never resolve. */
  stopWaitingForProgress(): void {
    this.progressClosing = true;
  }

  /**
   * Record one warning per thread whose commands shutdown cancelled. A thread leaves the collection only once its
   * note is written, and calls run one after another, so the persistence phase that follows a service overrun waits
   * for a note still being written and writes the rest before the database writer closes.
   */
  noteStoppedCommandsAtShutdown(commands: RestartWarnings): Promise<void> {
    const run = this.shutdownNotes.then(() => this.writeShutdownNotes(commands));
    this.shutdownNotes = run.catch(() => undefined);
    return run;
  }

  private async writeShutdownNotes(commands: RestartWarnings): Promise<void> {
    const stopped = this.shutdownCommands;
    if (!stopped) return;
    const failures: unknown[] = [];
    // The database writer admits a bounded queue, so writing every thread's note at once could drop some.
    for (const [threadId, commandIds] of stopped) {
      if (!this.progressClosing) {
        // The commands were stopped whether or not their cancellation saved, so the note is still written.
        await this.progress().waitForSaved(threadId).catch((error: unknown) => { failures.push(error); });
      }
      const written = [...commandIds];
      try {
        await commands.noteRestartOrphans(threadId, written);
        // A cancellation reported during the write joins this set and still needs its note from a later call.
        for (const toolCallId of written) commandIds.delete(toolCallId);
        if (commandIds.size === 0) stopped.delete(threadId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Could not record background command shutdown warnings");
  }

  private progress(): NonNullable<BackgroundToolSettlementEffect["acceptedProgress"]> {
    if (!this.acceptedProgress) throw new Error("Background tool settlement requires accepted progress composition");
    return this.acceptedProgress;
  }
}
