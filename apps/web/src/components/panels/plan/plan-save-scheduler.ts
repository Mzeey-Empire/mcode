import { PlanVersionSchema, type PlanSaveVersion, type PlanVersion } from "@mcode/contracts";
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

/**
 * One thread's plan edit session. `idle` means the editor follows the store.
 * `editing` holds the local text and what the server has acknowledged.
 * `conflict` holds the local text until the user picks a side.
 */
export type PlanDraftState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "editing";
      readonly target: DraftTarget;
      readonly text: string;
      readonly ackedText: string;
      readonly inFlight: PlanSaveVersion | null;
    }
  | { readonly kind: "conflict"; readonly text: string; readonly latest: PlanVersion; readonly canKeep: boolean };

type EditingState = Extract<PlanDraftState, { kind: "editing" }>;
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

const IDLE: PlanDraftState = { kind: "idle" };

/**
 * Autosaves one thread's plan edits through `plan.saveVersion`: debounced,
 * one save in flight, newer text coalesced into the next save, and a lost
 * response resent as the identical payload. A conflict holds the local text
 * until the user calls {@link keepMine} or {@link useSaved}.
 */
export class PlanSaveScheduler {
  #state: PlanDraftState = IDLE;
  readonly #listeners = new Set<() => void>();
  #debounce: TimerHandle | null = null;
  #retry: TimerHandle | null = null;
  #retryAttempt = 0;

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
    if (state.kind === "conflict") return;
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
   * Ends a settled session when the thread's latest version is a different
   * version, such as a new agent capture. A newer revision of the session's
   * own draft keeps the session, so the next save surfaces the conflict.
   */
  reconcile(latest: PlanVersion | null): void {
    const state = this.#state;
    if (state.kind !== "editing" || latest === null || latest.id === state.target.versionId) return;
    if (this.#isSettled(state)) this.#set(IDLE);
  }

  #isSettled(state: EditingState): boolean {
    return state.inFlight === null && state.text === state.ackedText && this.#debounce === null && this.#retry === null;
  }

  #set(next: PlanDraftState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
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
    if (state.kind !== "editing" || state.inFlight !== null || this.#retry !== null) return;
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
        // The server may have written it, so only the identical payload is
        // safe: it replays as a no-op, while newer text would conflict.
        this.#scheduleRetry(() => this.#transmit(payload));
        return;
      case "busy":
        this.#set({ ...state, inFlight: null });
        this.#scheduleRetry(() => this.#sendIfDue());
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
    this.#set({ kind: "conflict", text, latest, canKeep: latest.status !== "accepted" });
    this.deps.onVersion(latest);
  }
}
