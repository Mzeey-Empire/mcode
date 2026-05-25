/**
 * Coalesce async work triggered by bursty events (e.g. tsc emitting many
 * files into a watched directory).
 *
 * Behaviour:
 *   - Multiple synchronous trigger calls within `debounceMs` collapse into
 *     ONE run.
 *   - Triggers that arrive WHILE a run is in flight do NOT spawn parallel
 *     runs; they collectively schedule exactly one follow-up run after the
 *     current one completes. The follow-up is itself debounced.
 *   - If the wrapped function throws, state resets so subsequent triggers
 *     still work.
 *
 * The naive pattern (`if (timer) clearTimeout(timer); timer = setTimeout(...)`)
 * does not cover the in-flight case: a long-running build (~3s in the
 * desktop dev orchestrator) can have new events arrive after the build has
 * already started, which schedule another full run instead of being absorbed.
 * That bug surfaced as the dev script restarting Electron twice for a single
 * "tsc settled" event.
 *
 * @param {() => (void | Promise<void>)} fn The work to run.
 * @param {number} debounceMs Debounce window for coalescing bursts.
 * @returns {() => void} A trigger function.
 */
export function makeCoalescedAsync(fn, debounceMs) {
  let timer = null;
  let running = false;
  let pending = false;

  function trigger() {
    if (running) {
      pending = true;
      return;
    }
    if (timer) clearTimeout(timer);
    // The timer dispatches via void-and-catch so an exception in `fn` does
    // not surface as an unhandled rejection on the microtask scheduler;
    // callers can still surface their own errors inside `fn` if they want.
    timer = setTimeout(() => {
      void run().catch(() => {});
    }, debounceMs);
  }

  async function run() {
    timer = null;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        trigger();
      }
    }
  }

  return trigger;
}
