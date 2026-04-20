/**
 * Cache for slash-command skills.
 *
 * Module-scoped so the cache survives Composer remounts. Single-flights
 * concurrent `load()` calls. Reacts to `skills.changed` push events
 * (wired in `ws-events.ts`) by invalidating.
 */

import { create } from "zustand";
import { getTransport, type SkillInfo } from "@/transport";

/** State and actions for the skills Zustand store. */
interface SkillsState {
  /** Fetched skill list, or null if not yet loaded or invalidated. */
  skills: SkillInfo[] | null;
  /** The cwd used for the last successful fetch. */
  cwd: string | undefined;
  /** Whether a fetch is currently in-flight. */
  isLoading: boolean;
  /** Error from the last failed fetch, if any. */
  error: Error | null;
  /** The in-flight promise, used to enforce single-flight semantics. */
  inflight: Promise<SkillInfo[]> | null;

  /**
   * Load skills for the given cwd.
   *
   * Returns cached data if still fresh (within TTL) and cwd matches.
   * Concurrent calls with any cwd while a request is in-flight all
   * receive the same promise.
   */
  load(cwd?: string, force?: boolean): Promise<SkillInfo[]>;

  /**
   * Invalidate the cached skills so the next `load()` re-fetches from
   * the server regardless of TTL.
   */
  invalidate(): void;

  /**
   * Reset all store state to initial values, including in-flight tracking.
   * Used in tests for cleanup between cases.
   */
  reset(): void;
}

/** Skills are considered fresh for 5 minutes after the last successful fetch. */
const CACHE_TTL_MS = 5 * 60 * 1000;

// Module-level timestamp so TTL survives store resets in tests but still
// gets cleared when `reset()` or `invalidate()` is explicitly called.
let lastFetchedAt = 0;

/** Module-scoped Zustand store for skill caching with single-flight loading. */
export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: null,
  cwd: undefined,
  isLoading: false,
  error: null,
  inflight: null,

  // Non-async so the return value IS the cached/in-flight promise directly,
  // enabling identity equality (p1 === p2) for single-flight callers.
  load(cwd, force = false): Promise<SkillInfo[]> {
    const state = get();

    // Return cache if fresh and same cwd
    if (
      !force &&
      state.skills &&
      state.cwd === cwd &&
      Date.now() - lastFetchedAt < CACHE_TTL_MS
    ) {
      return Promise.resolve(state.skills);
    }

    // Single-flight: return existing in-flight promise for any concurrent caller
    if (state.inflight) return state.inflight;

    // Create and register the in-flight promise atomically so a second
    // synchronous caller sees it immediately via get().inflight.
    let resolveInflight!: (skills: SkillInfo[]) => void;
    let rejectInflight!: (err: unknown) => void;
    const promise = new Promise<SkillInfo[]>((res, rej) => {
      resolveInflight = res;
      rejectInflight = rej;
    });

    set({ isLoading: true, error: null, inflight: promise });

    // Kick off the actual fetch outside the synchronous set() block.
    (async () => {
      try {
        const skills = await getTransport().listSkills(cwd);
        lastFetchedAt = Date.now();
        set({ skills, cwd, isLoading: false, inflight: null, error: null });
        resolveInflight(skills);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn("[skillsStore] load failed", error);
        set({ isLoading: false, inflight: null, error });
        rejectInflight(error);
      }
    })();

    return promise;
  },

  invalidate() {
    set({ skills: null, cwd: undefined, error: null });
    lastFetchedAt = 0;
  },

  reset() {
    set({ skills: null, cwd: undefined, isLoading: false, error: null, inflight: null });
    lastFetchedAt = 0;
  },
}));
