import {
  THREAD_STARTUP_TRANSCRIPT_MAX_CHARS,
  THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES,
  ThreadStartupTranscriptEntrySchema,
  ThreadStartupSchema,
  getThreadStartupPhases,
  type ThreadStartup,
  type ThreadStartupBlock,
  type ThreadStartupError,
  type ThreadStartupStepDetail,
  type ThreadStartupPhase,
  type ThreadStartupStartInput,
} from "@mcode/contracts";
import { ThreadStartupStore } from "./persistence/thread-startup-store.js";
import type { z } from "zod";
import type { Thread } from "@mcode/contracts";
import { ThreadStore } from "../thread-control/persistence/thread-store.js";
import type { threadWriteOperations } from "../thread-control/persistence/thread-write-operations.js";

/** Complete serializable input for creating and binding a startup's thread. */
export interface ThreadStartupThreadCreation {
  readonly args: z.output<typeof threadWriteOperations.create.input>;
  readonly worktreePath?: string;
}

const terminalStates = new Set<ThreadStartup["state"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Signals that an existing startup ID belongs to a different startup request. */
export class ThreadStartupConflictError extends Error {
  constructor(startupId: string) {
    super(`Startup ID ${startupId} is already assigned to a different request`);
    this.name = "ThreadStartupConflictError";
  }
}

/** Applies complete startup transitions synchronously on the database owner's connection. */
export class ThreadStartupStateStore {
  constructor(
    private readonly startupRepo: ThreadStartupStore,
    private readonly now: () => Date = () => new Date(),
    private readonly threads?: ThreadStore,
  ) {}

  /** Start one lifecycle or return its existing snapshot when the request matches. */
  start(input: ThreadStartupStartInput, requestFingerprint?: string): ThreadStartup {
    const existing = this.startupRepo.findById(input.startupId);
    if (existing) {
      const persistedFingerprint = this.startupRepo.requestFingerprint(input.startupId);
      // A matching fingerprint is the same request even when an older server
      // derived a different kind or step list for it, as before record v2.
      const sameRequest = persistedFingerprint && requestFingerprint
        ? persistedFingerprint === requestFingerprint
        : existing.kind === input.kind
          && existing.steps.some((step) => step.phase === "fetch") === (input.fetch !== undefined);
      if (existing.workspaceId === input.workspaceId && sameRequest) return existing;
      throw new ThreadStartupConflictError(input.startupId);
    }

    const timestamp = this.now().toISOString();
    const phases = getThreadStartupPhases(input.kind, input.fetch !== undefined);
    const startup: ThreadStartup = {
      startupId: input.startupId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      state: "pending",
      phase: phases[0],
      steps: phases.map((phase) => ({
        phase, state: "pending",
        ...(phase === "fetch" && input.fetch ? { detail: { phase, ...input.fetch } } : {}),
      })),
      transcript: [],
      cancellation: "none",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.startupRepo.insert(startup, requestFingerprint);
    return startup;
  }

  /** Bind a newly persisted direct thread in the same SQLite commit. */
  createAndBindThread(startupId: string, input: ThreadStartupThreadCreation): { thread: Thread; startup: ThreadStartup } {
    const threads = this.threads;
    if (!threads) throw new Error("Startup thread creation requires its worker thread store");
    return this.startupRepo.transaction(() => {
      const startup = this.require(startupId);
      if (startup.workspaceId !== input.args[0]) throw new ThreadStartupConflictError(startupId);
      if (startup.threadId) {
        const thread = threads.findById(startup.threadId);
        if (!thread) throw new Error("Startup is bound to a missing thread");
        return { thread, startup };
      }
      if (isTerminal(startup)) throw new Error("Terminal startup cannot create another thread");
      let thread = threads.create(...input.args);
      if (input.worktreePath !== undefined) {
        if (!threads.updateWorktreePath(thread.id, input.worktreePath)) throw new Error("Startup worktree path could not persist");
        const persisted = threads.findById(thread.id);
        if (!persisted) throw new Error("Startup thread disappeared during creation");
        thread = persisted;
      }
      return { thread, startup: this.bindThread(startupId, thread.id) };
    });
  }

  /** Read one authoritative lifecycle snapshot. */
  get(startupId: string): ThreadStartup | null {
    return this.startupRepo.findById(startupId);
  }

  /** List authoritative lifecycle snapshots for one workspace. */
  list(workspaceId: string): ThreadStartup[] {
    return this.startupRepo.listByWorkspace(workspaceId);
  }

  /** Find an active startup or the newest terminal record associated with one Thread. */
  findByThreadId(threadId: string): ThreadStartup | null {
    return this.startupRepo.findByThreadId(threadId);
  }

  /** Mark the current phase active or move from it to the next phase. */
  advance(startupId: string, phase: ThreadStartupPhase, detail?: ThreadStartupStepDetail): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    if (startup.state === "blocked") throw new Error("Blocked startup must resume before advancing");
    const targetIndex = startup.steps.findIndex((step) => step.phase === phase);
    if (targetIndex < 0) throw new Error(`Phase ${phase} does not apply to startup ${startupId}`);
    const timestamp = this.now().toISOString();

    if (startup.state === "pending") {
      if (targetIndex !== 0) throw new Error("Startup must begin with its first phase");
      return this.persistNext({
        ...startup,
        state: "running",
        phase,
        steps: startup.steps.map((step, index) => index === 0
          ? { ...step, state: "running", startedAt: timestamp, detail: detail ?? step.detail } : step),
      });
    }

    const activeIndex = startup.steps.findIndex((step) => step.state === "running");
    if (targetIndex === activeIndex) {
      if (!detail) return startup;
      return this.persistNext({ ...startup, steps: startup.steps.map((step, index) =>
        index === activeIndex ? { ...step, detail } : step) });
    }
    if (targetIndex !== activeIndex + 1) throw new Error("Startup phases must advance in order");
    return this.persistNext({
      ...startup,
      phase,
      steps: startup.steps.map((step, index) => {
        if (index === activeIndex) return { ...step, state: "completed", endedAt: timestamp };
        if (index === targetIndex) return { ...step, state: "running", startedAt: timestamp, detail: detail ?? step.detail };
        return step;
      }),
    });
  }

  /** Bind the durable thread identity when a startup flow creates or reuses a thread. */
  bindThread(startupId: string, threadId: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup) || startup.threadId === threadId) return startup;
    return this.persistNext({ ...startup, threadId });
  }

  /** Remove a binding after the owning creation flow confirms that its child was deleted. */
  clearThreadBinding(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    if (!startup.threadId) return startup;
    return this.persistNext({ ...startup, threadId: undefined });
  }

  /** Append one bounded output entry and retain only the newest bounded transcript. */
  appendOutput(startupId: string, content: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    const entry = ThreadStartupTranscriptEntrySchema().parse({
      phase: startup.phase,
      content,
      createdAt: this.now().toISOString(),
    });
    return this.persistNext({
      ...startup,
      transcript: retainTranscript([...startup.transcript, entry]),
    });
  }

  /** Complete the final active phase and make the lifecycle terminal. */
  complete(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    const timestamp = this.now().toISOString();
    // An interrupted record completes when its remaining phases are resolved
    // outside this lifecycle, for example when the user continues without Setup.
    if (startup.state === "interrupted") {
      if (startup.cancellation === "requested") return this.markCancelled(startupId);
      return this.persistNext({
        ...startup,
        state: "completed",
        phase: startup.steps.at(-1)!.phase,
        block: undefined,
        steps: startup.steps.map((step) => {
          if (step.state === "interrupted") return { ...step, state: "skipped", endedAt: timestamp };
          if (step.state === "pending") return { ...step, state: "completed", endedAt: timestamp };
          return step;
        }),
      });
    }
    if (isTerminal(startup)) return startup;
    const activeIndex = this.activeIndex(startup);
    if (activeIndex !== startup.steps.length - 1) throw new Error("Startup cannot complete before its final phase");
    return this.persistNext({
      ...startup,
      state: "completed",
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "completed", endedAt: timestamp }
        : step),
    });
  }

  /** Keep the current phase recoverably blocked until the user retries or continues. */
  block(startupId: string, block: ThreadStartupBlock, detail?: ThreadStartupStepDetail): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup) || startup.state === "blocked") return startup;
    const activeIndex = this.activeIndex(startup);
    return this.persistNext({
      ...startup,
      state: "blocked",
      phase: startup.steps[activeIndex].phase,
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "blocked", endedAt: this.now().toISOString(), detail: detail ?? step.detail }
        : step),
      block,
    });
  }

  /** Resume the current blocked phase for a new Setup attempt. */
  resume(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    // Interrupted records are recoverable: the process behind them died, but
    // the user can still retry or bypass the phase that never finished.
    if (startup.state !== "blocked" && startup.state !== "interrupted") return startup;
    const activeIndex = this.currentIndex(startup);
    return this.persistNext({
      ...startup,
      state: "running",
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "running", startedAt: this.now().toISOString(), endedAt: undefined,
          detail: step.phase === "setup" ? undefined : step.detail }
        : step),
      block: undefined,
    });
  }

  /** Skip the current recoverable phase and enter the next phase. */
  skip(startupId: string, phase: ThreadStartupPhase, detail?: ThreadStartupStepDetail): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup) && startup.state !== "interrupted") return startup;
    const activeIndex = this.currentIndex(startup);
    if (startup.steps[activeIndex]?.phase !== phase) {
      throw new Error(`Startup ${startupId} cannot skip phase ${phase}`);
    }
    const next = startup.steps[activeIndex + 1];
    if (!next) throw new Error("Startup cannot skip its final phase");
    const timestamp = this.now().toISOString();
    return this.persistNext({
      ...startup,
      state: "running",
      phase: next.phase,
      steps: startup.steps.map((step, index) => {
        if (index === activeIndex) return { ...step, state: "skipped", endedAt: timestamp, detail: detail ?? step.detail };
        if (index === activeIndex + 1) return { ...step, state: "running", startedAt: timestamp };
        return step;
      }),
      block: undefined,
    });
  }

  /** Fail the current phase with structured error detail. */
  fail(startupId: string, error: ThreadStartupError, detail?: ThreadStartupStepDetail): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup)) return startup;
    const activeIndex = this.currentIndex(startup);
    return this.persistNext({
      ...startup,
      state: "failed",
      phase: startup.steps[activeIndex].phase,
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "failed", endedAt: this.now().toISOString(), detail: detail ?? step.detail }
        : step),
      error,
      block: undefined,
    });
  }

  /** Record cancellation intent. Integrations must query this before they stop owned work. */
  cancel(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    if (isTerminal(startup) || startup.cancellation === "requested") return startup;
    return this.persistNext({ ...startup, cancellation: "requested" });
  }

  /** Mark a startup cancelled only after its owning integration stops its own work. */
  markCancelled(startupId: string): ThreadStartup {
    const startup = this.require(startupId);
    // An interrupted record may still carry a cancellation request; honour it.
    if (isTerminal(startup) && startup.state !== "interrupted") return startup;
    const activeIndex = this.currentIndex(startup);
    return this.persistNext({
      ...startup,
      state: "cancelled",
      phase: startup.steps[activeIndex].phase,
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "cancelled", endedAt: this.now().toISOString() }
        : step),
      cancellation: "requested",
      block: undefined,
    });
  }

  /** Return whether an integration must stop or avoid starting more owned work. */
  isCancellationRequested(startupId: string): boolean {
    return this.require(startupId).cancellation === "requested";
  }

  /** Return every startup record left interrupted by a server restart. */
  listInterrupted(): ThreadStartup[] {
    return this.startupRepo.listInterrupted();
  }

  /** Mark all incomplete startup records as interrupted after a server restart. */
  interruptNonterminalOnStartup(): ThreadStartup[] {
    return this.startupRepo.listInterruptible().map((startup) => this.interrupt(startup));
  }

  /** Interrupt one bounded recovery page, retaining its cursor across malformed rows. */
  interruptBatch(afterStartupId?: string): { records: ThreadStartup[]; nextCursor: string | null } {
    const batch = this.startupRepo.interruptibleBatch(afterStartupId);
    return { records: batch.records.map((startup) => this.interrupt(startup)), nextCursor: batch.nextCursor };
  }

  private interrupt(startup: ThreadStartup): ThreadStartup {
    const activeIndex = this.currentIndex(startup);
    return this.persistNext({
      ...startup,
      state: "interrupted",
      phase: startup.steps[activeIndex].phase,
      steps: startup.steps.map((step, index) => index === activeIndex
        ? { ...step, state: "interrupted", endedAt: this.now().toISOString() }
        : step),
      block: undefined,
    });
  }

  private require(startupId: string): ThreadStartup {
    const startup = this.startupRepo.findById(startupId);
    if (!startup) throw new Error(`Startup ${startupId} was not found`);
    return startup;
  }

  private activeIndex(startup: ThreadStartup): number {
    const index = startup.steps.findIndex((step) => step.state === "running");
    if (index < 0) throw new Error(`Startup ${startup.startupId} has no active phase`);
    return index;
  }

  private currentIndex(startup: ThreadStartup): number {
    if (startup.state === "running") return this.activeIndex(startup);
    return startup.steps.findIndex((step) => step.phase === startup.phase);
  }

  private persistNext(startup: ThreadStartup): ThreadStartup {
    const persisted = ThreadStartupSchema().parse({
      ...startup,
      revision: startup.revision + 1,
      updatedAt: this.now().toISOString(),
    });
    this.startupRepo.update(persisted);
    return persisted;
  }

}

function retainTranscript(transcript: ThreadStartup["transcript"]): ThreadStartup["transcript"] {
  const retained = transcript.slice(-THREAD_STARTUP_TRANSCRIPT_MAX_ENTRIES);
  while (retained.reduce((total, entry) => total + entry.content.length, 0) > THREAD_STARTUP_TRANSCRIPT_MAX_CHARS) {
    retained.shift();
  }
  return retained;
}

function isTerminal(startup: ThreadStartup): boolean {
  return terminalStates.has(startup.state);
}
