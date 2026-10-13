import { PlanVersionSchema, type PlanImplement, type PlanSaveVersion, type PlanVersion } from "@mcode/contracts";
import { RpcError } from "@/transport/ws-transport";

/** Quiet period after the last keystroke before a plan draft saves. */
export const PLAN_SAVE_DEBOUNCE_MS = 500;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 16_000;

/** The draft an edit session saves into, and the revision its next save expects. */
export interface DraftTarget {
  readonly versionId: string;
  readonly baseVersionId: string;
  readonly baseRevision: number;
}

interface EditingState {
  readonly kind: "editing";
  readonly target: DraftTarget;
  readonly text: string;
  readonly ackedText: string;
  readonly inFlight: PlanSaveVersion | null;
}

type ImplementPending = NonNullable<PlanImplement["pending"]>;

/**
 * One thread's plan edit session. `idle` means the editor follows the store.
 * `editing` holds the local text and what the server has acknowledged.
 * `conflict` holds the local text until the user picks a side.
 * `implementing` freezes the text on screen while an Implement request runs;
 * `resume` is the session to restore if the request did not carry its text.
 */
export type PlanDraftState =
  | { readonly kind: "idle" }
  | EditingState
  | { readonly kind: "conflict"; readonly text: string; readonly latest: PlanVersion; readonly canKeep: boolean }
  | {
      readonly kind: "implementing";
      readonly text: string;
      readonly carried: ImplementPending | null;
      readonly resume: EditingState | null;
    };

/** The version an Implement request names and the text it carries. */
export type ImplementBasis = Pick<PlanImplement, "versionId" | "expectedRevision" | "pending">;

/** How an Implement request ended, as the scheduler needs to know it. */
export type ImplementOutcome =
  | { readonly kind: "admitted" }
  | { readonly kind: "conflict"; readonly latest: PlanVersion }
  | { readonly kind: "failed"; readonly latest: PlanVersion | null };

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** Side effects a {@link PlanSaveScheduler} needs, injected so tests control time and the wire. */
export interface PlanSaveSchedulerDeps {
  readonly save: (payload: PlanSaveVersion) => Promise<PlanVersion>;
  /** Receives every version the server returns, saved or conflicting. */
  readonly onVersion: (version: PlanVersion) => void;
  readonly newId: () => string;
  readonly setTimeout: (callback: () => void, ms: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
}

/** How a failed save is handled: resend, retry later, hold for the user, or stop. */
export type PlanSaveFailure =
  | { readonly kind: "lost" }
  | { readonly kind: "busy" }
  | { readonly kind: "conflict"; readonly latest: PlanVersion }
  | { readonly kind: "rejected" };

/**
 * Classifies a `plan.saveVersion` failure. Anything that is not a typed RPC
 * error (timeout, disconnect) may have been written, so it counts as lost.
 */
export function classifyPlanSaveFailure(error: unknown): PlanSaveFailure {
  if (!(error instanceof RpcError)) return { kind: "lost" };
  if (error.code === "plan_busy") return { kind: "busy" };
  if (error.code === "plan_conflict" || error.code === "plan_read_only") {
    const latest = PlanVersionSchema().safeParse(error.data?.latestVersion);
    if (latest.success) return { kind: "conflict", latest: latest.data };
  }
  return { kind: "rejected" };
}

// A draft is saved into by its id; a ready version is forked under a new id.
function targetFor(latest: PlanVersion, newId: () => string): DraftTarget {
  if (latest.status === "draft") {
    return { versionId: latest.id, baseVersionId: latest.baseVersionId ?? latest.id, baseRevision: latest.revision };
  }
  return { versionId: newId(), baseVersionId: latest.id, baseRevision: latest.revision };
}

function isSessionRevision(version: PlanVersion, target: DraftTarget): boolean {
  return version.id === target.versionId && version.revision === target.baseRevision;
}

const IDLE: PlanDraftState = { kind: "idle" };

/** The version an Implement acts on, and the thread's latest version. */
export interface ImplementPick {
  readonly target: PlanVersion;
  readonly latest: PlanVersion;
}

type ImplementingState = Extract<PlanDraftState, { kind: "implementing" }>;

function canHandOff(state: PlanDraftState): state is Extract<PlanDraftState, { kind: "idle" | "editing" }> {
  return state.kind === "idle" || state.kind === "editing";
}

function unsentEditOfLatest(editing: EditingState | null, { target, latest }: ImplementPick): ImplementPending | null {
  if (editing === null || editing.text === editing.ackedText || target.id !== latest.id) return null;
  return { ...editing.target, contentMd: editing.text };
}

function revisionAfterSaving(carried: ImplementPending): number {
  return carried.baseRevision + 1;
}

function latestHoldsCarriedEdit(carried: ImplementPending, outcome: ImplementOutcome): boolean {
  if (outcome.kind === "admitted") return true;
  return outcome.latest?.id === carried.versionId && outcome.latest.contentMd === carried.contentMd;
}

function sessionAfterImplement(state: ImplementingState, outcome: ImplementOutcome): PlanDraftState {
  const { resume, carried } = state;
  if (resume === null || resume.text === resume.ackedText) return IDLE;
  return carried !== null && latestHoldsCarriedEdit(carried, outcome) ? IDLE : resume;
}

/**
 * Autosaves one thread's plan edits through `plan.saveVersion`: debounced,
 * one save in flight, newer text coalesced into the next save, and a lost or
 * busy response resent as the identical payload. A conflict holds the local text
 * until the user calls {@link keepMine} or {@link useSaved}.
 */
export class PlanSaveScheduler {
  #state: PlanDraftState = IDLE;
  readonly #listeners = new Set<() => void>();
  #debounce: TimerHandle | null = null;
  #retry: TimerHandle | null = null;
  #retryAttempt = 0;
  #paused = false;
  readonly #settled = new Set<() => void>();

  constructor(
    private readonly threadId: string,
    private readonly deps: PlanSaveSchedulerDeps,
  ) {}

  /** `useSyncExternalStore` subscription. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** `useSyncExternalStore` snapshot; a new object on every change. */
  readonly getSnapshot = (): PlanDraftState => this.#state;

  /** Records the editor's text. The first edit opens a session against `latest`. */
  edit(text: string, latest: PlanVersion): void {
    const state = this.#state;
    if (state.kind === "conflict" || state.kind === "implementing") return;
    if (state.kind === "editing" && state.text === text) return;
    this.#set(
      state.kind === "editing"
        ? { ...state, text }
        : { kind: "editing", target: targetFor(latest, this.deps.newId), text, ackedText: latest.contentMd, inFlight: null },
    );
    this.#armDebounce();
  }

  /** Sends pending text now instead of waiting for the debounce. */
  flush(): void {
    this.#clearDebounce();
    this.#sendIfDue();
  }

  /** Saves the held text over the conflicting latest version. */
  keepMine(): void {
    const state = this.#state;
    if (state.kind !== "conflict" || !state.canKeep) return;
    this.#set({
      kind: "editing",
      target: targetFor(state.latest, this.deps.newId),
      text: state.text,
      ackedText: state.latest.contentMd,
      inFlight: null,
    });
    this.#sendIfDue();
  }

  /** Discards the held text; the editor shows the latest version again. */
  useSaved(): void {
    if (this.#state.kind === "conflict") this.#set(IDLE);
  }

  /**
   * Ends a settled session when the thread's latest version is not the
   * revision the session saved, such as a new agent capture or another
   * window's save to the same draft, so the editor shows what Implement
   * would send. An unsettled session stays, and its next save surfaces the
   * conflict.
   */
  reconcile(latest: PlanVersion | null): void {
    const state = this.#state;
    if (state.kind !== "editing" || latest === null || isSessionRevision(latest, state.target)) return;
    if (this.#isSettled(state)) this.#set(IDLE);
  }

  /**
   * Hands the session to an Implement request. Waits for the save in flight,
   * since its response decides the revision on screen, then calls `pick` for
   * the version to implement and its thread's latest. Unsent text rides the
   * request only when the latest version is the one on screen. Returns null,
   * and resumes autosave, when there is nothing to implement or a conflict
   * waits for the user.
   */
  async beginImplement(pick: () => ImplementPick | null): Promise<ImplementBasis | null> {
    if (!canHandOff(this.#state)) return null;
    this.#paused = true;
    this.#clearDebounce();
    await this.#untilNoSaveInFlight();
    const state = this.getSnapshot();
    const picked = pick();
    if (!canHandOff(state) || picked === null) {
      this.#resumeAutosave();
      return null;
    }
    const editing = state.kind === "editing" ? state : null;
    const carried = unsentEditOfLatest(editing, picked);
    this.#set({ kind: "implementing", text: editing?.text ?? picked.latest.contentMd, carried, resume: editing });
    if (carried) return { versionId: carried.versionId, expectedRevision: revisionAfterSaving(carried), pending: carried };
    return { versionId: picked.target.id, expectedRevision: picked.target.revision };
  }

  /** Ends the Implement hand-off and resumes autosave for any text the request did not carry. */
  finishImplement(outcome: ImplementOutcome): void {
    const state = this.#state;
    if (state.kind !== "implementing") return;
    if (state.carried && outcome.kind === "conflict") {
      this.#paused = false;
      this.#enterConflict(state.text, outcome.latest);
      return;
    }
    if (outcome.kind !== "admitted" && outcome.latest) this.deps.onVersion(outcome.latest);
    this.#set(sessionAfterImplement(state, outcome));
    this.#resumeAutosave();
  }

  #untilNoSaveInFlight(): Promise<void> {
    const state = this.#state;
    if (state.kind !== "editing" || state.inFlight === null) return Promise.resolve();
    return new Promise((resolve) => this.#settled.add(resolve));
  }

  #resumeAutosave(): void {
    this.#paused = false;
    if (this.#state.kind === "editing") this.#armDebounce();
  }

  #isSettled(state: EditingState): boolean {
    return state.inFlight === null && state.text === state.ackedText && this.#debounce === null && this.#retry === null;
  }

  #set(next: PlanDraftState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
    if (next.kind === "editing" && next.inFlight !== null) return;
    const settled = [...this.#settled];
    this.#settled.clear();
    for (const resolve of settled) resolve();
  }

  #armDebounce(): void {
    this.#clearDebounce();
    this.#debounce = this.deps.setTimeout(() => {
      this.#debounce = null;
      this.#sendIfDue();
    }, PLAN_SAVE_DEBOUNCE_MS);
  }

  #clearDebounce(): void {
    if (this.#debounce === null) return;
    this.deps.clearTimeout(this.#debounce);
    this.#debounce = null;
  }

  #sendIfDue(): void {
    const state = this.#state;
    if (this.#paused || state.kind !== "editing" || state.inFlight !== null || this.#retry !== null) return;
    if (state.text === state.ackedText) return;
    const payload: PlanSaveVersion = { threadId: this.threadId, ...state.target, contentMd: state.text };
    this.#set({ ...state, inFlight: payload });
    this.#transmit(payload);
  }

  #transmit(payload: PlanSaveVersion): void {
    this.deps.save(payload).then(
      (version) => this.#onSaved(payload, version),
      (error: unknown) => this.#onFailed(payload, classifyPlanSaveFailure(error)),
    );
  }

  // Identity comparison drops responses to a payload the session no longer owns.
  #ownFlight(payload: PlanSaveVersion): EditingState | null {
    const state = this.#state;
    return state.kind === "editing" && state.inFlight === payload ? state : null;
  }

  #onSaved(payload: PlanSaveVersion, version: PlanVersion): void {
    const state = this.#ownFlight(payload);
    if (!state) return;
    this.#retryAttempt = 0;
    this.#set({
      ...state,
      target: { ...state.target, baseRevision: version.revision },
      ackedText: payload.contentMd,
      inFlight: null,
    });
    this.deps.onVersion(version);
    if (this.#debounce === null) this.#sendIfDue();
  }

  #onFailed(payload: PlanSaveVersion, failure: PlanSaveFailure): void {
    const state = this.#ownFlight(payload);
    if (!state) return;
    switch (failure.kind) {
      case "lost":
      case "busy":
        // A lost attempt of this payload may have been written, and busy
        // writes nothing, so only the identical payload is safe: it saves or
        // replays as a no-op, while newer text at this base would conflict.
        // Newer text follows from #onSaved once this one is acknowledged.
        this.#scheduleRetry(() => this.#transmit(payload));
        return;
      case "conflict":
        this.#enterConflict(state.text, failure.latest);
        return;
      case "rejected":
        // Text stays unacknowledged, so the next edit or flush tries again.
        this.#set({ ...state, inFlight: null });
        return;
    }
  }

  #scheduleRetry(run: () => void): void {
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.#retryAttempt, RETRY_MAX_MS);
    this.#retryAttempt += 1;
    this.#retry = this.deps.setTimeout(() => {
      this.#retry = null;
      run();
    }, delay);
  }

  #enterConflict(text: string, latest: PlanVersion): void {
    this.#clearDebounce();
    this.#retryAttempt = 0;
    this.#set({ kind: "conflict", text, latest, canKeep: latest.status === "draft" || latest.status === "ready" });
    this.deps.onVersion(latest);
  }
}
