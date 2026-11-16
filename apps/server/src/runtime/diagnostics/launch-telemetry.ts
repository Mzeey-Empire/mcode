import { z } from "zod";
import {
  LAUNCH_MIN_WINDOW_MS,
  LAUNCH_RETENTION_MS,
  LAUNCH_RPC_LIMIT,
  LAUNCH_SETTLE_MS,
  type LaunchMark,
  type ServerLaunchTelemetry,
} from "@mcode/contracts/launch-telemetry";

const TICK_MS = 50;
const STALL_MS = 100;

/** A request received during the launch window. The window reports it as unanswered until `answerRpc` records it. */
export type LaunchRpc = { method: string; startAt: number };

type LaunchTelemetryRuntime = {
  now(): number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  rss(): number;
};

/** Creates the process-local, bounded launch observation window. */
export function createLaunchTelemetry(launchId: string | undefined, runtime: LaunchTelemetryRuntime) {
  let phase: "disabled" | "startup" | "window" | "closing" | "delivered" | "expired" =
    z.string().uuid().safeParse(launchId).success ? "startup" : "disabled";
  let migrated = false;
  let marks: LaunchMark[] = [];
  let tasks: ServerLaunchTelemetry["tasks"] = [];
  let rpcs: ServerLaunchTelemetry["rpcs"] = [];
  let openRpcs = new Set<LaunchRpc>();
  let stalls: ServerLaunchTelemetry["stalls"] = [];
  let memory: ServerLaunchTelemetry["memory"] = [];
  let rpcsDropped = 0;
  let listenAt = 0;
  let lastTick = 0;
  let closeAt = 0;
  let tick: ReturnType<typeof setInterval> | undefined;
  let sample: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let delivery: ((snapshot: ServerLaunchTelemetry) => void) | undefined;
  const recording = () => phase === "startup" || phase === "window" || phase === "closing";
  const observing = () => phase === "window" || phase === "closing";
  function stop() {
    runtime.clearInterval(tick);
    runtime.clearInterval(sample);
    runtime.clearTimeout(expiry);
  }
  function drop() {
    marks = [];
    tasks = [];
    rpcs = [];
    openRpcs = new Set();
    stalls = [];
    memory = [];
    rpcsDropped = 0;
  }
  function expire() {
    phase = "expired";
    stop();
    drop();
  }
  function deliver(resolve: (snapshot: ServerLaunchTelemetry) => void, launch: string) {
    const snapshot = {
      launchId: launch,
      migrated,
      marks: marks.sort((a, b) => a.at - b.at),
      listenAt,
      windowEndAt: lastTick,
      rpcs,
      unansweredRpcs: [...openRpcs],
      rpcsDropped,
      tasks,
      stalls,
      memory,
    };
    phase = "delivered";
    stop();
    drop();
    resolve(snapshot);
  }
  function onTick() {
    const now = runtime.now();
    if (now - lastTick >= STALL_MS) stalls.push({ startAt: lastTick, endAt: now });
    lastTick = now;
    if (delivery && launchId && now >= closeAt) deliver(delivery, launchId);
  }
  return {
    get phase() { return phase; },
    mark(name: string) { if (recording()) marks.push({ name, at: runtime.now() }); },
    appendMarks(values: LaunchMark[]) { if (recording()) marks.push(...values); },
    setMigrated(value: boolean) { if (recording()) migrated = value; },
    listen() {
      if (phase !== "startup") return;
      phase = "window";
      listenAt = lastTick = runtime.now();
      tick = runtime.setInterval(onTick, TICK_MS);
      tick.unref();
      sample = runtime.setInterval(() => memory.push({ at: runtime.now(), rssBytes: runtime.rss() }), 1_000);
      sample.unref();
      expiry = runtime.setTimeout(expire, LAUNCH_RETENTION_MS);
      expiry.unref();
    },
    /**
     * Opens a request received between listen and delivery. Returns undefined outside the window or once the window
     * is full.
     */
    openRpc(method: string, startAt: number): LaunchRpc | undefined {
      if (!observing()) return undefined;
      if (rpcs.length + openRpcs.size === LAUNCH_RPC_LIMIT) {
        rpcsDropped++;
        return undefined;
      }
      const rpc = { method, startAt };
      openRpcs.add(rpc);
      return rpc;
    },
    answerRpc(rpc: LaunchRpc, responseBytes: number) {
      if (!openRpcs.delete(rpc)) return;
      rpcs.push({ ...rpc, durationMs: runtime.now() - rpc.startAt, responseBytes });
    },
    trackLaunchTask<T>(name: string, promise: Promise<T>): Promise<T> {
      if (!recording()) return promise;
      const task: ServerLaunchTelemetry["tasks"][number] = { name, startAt: runtime.now(), endAt: null };
      tasks.push(task);
      return promise.finally(() => {
        if (recording()) task.endAt = runtime.now();
      });
    },
    /**
     * Ends the window on the first tick at or after the later of the minimum window and `usableAt` plus the settle
     * time. A `usableAt` after now counts as now, so a client cannot hold the window past the settle time after its
     * read. Ending on a tick records a stall that is still open in full. Without `usableAt` the next tick ends it.
     * Returns undefined when the window has not opened or has already closed.
     */
    close(usableAt?: number): Promise<ServerLaunchTelemetry> | undefined {
      if (phase !== "window") return;
      phase = "closing";
      runtime.clearTimeout(expiry);
      closeAt = usableAt === undefined
        ? listenAt
        : Math.max(listenAt + LAUNCH_MIN_WINDOW_MS, Math.min(usableAt, runtime.now()) + LAUNCH_SETTLE_MS);
      return new Promise((resolve) => { delivery = resolve; });
    },
    /** Ends a held window on the next tick, so closing the HTTP server never waits for the window to close. */
    endNow() {
      if (phase === "closing") closeAt = 0;
    },
  };
}

/** Launch recorder shared by bootstrap and transport in this process. */
export const launchTelemetry = createLaunchTelemetry(process.env.MCODE_LAUNCH_ID, {
  now: Date.now,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  rss: () => process.memoryUsage().rss,
});
