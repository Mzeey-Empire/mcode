import * as NodeHTTP from "node:http";
import * as NodeNet from "node:net";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  LAUNCH_RETENTION_MS,
  LAUNCH_RPC_LIMIT,
  LAUNCH_SETTLE_MS,
  LAUNCH_USABLE_LIMIT_MS,
  SERVER_STARTUP_TIMEOUT_MS,
  type ServerLaunchTelemetry,
} from "@mcode/contracts/launch-telemetry";
import { createLaunchTelemetry } from "./launch-telemetry.js";
import { handleLaunchTelemetryRequest } from "../../application/transport/launch-telemetry-route.js";

const id = "d98138cd-a571-49b8-ae76-8ec6507c3201";
// Built per call so each recorder picks up the fake timers installed in beforeEach.
const fakeRuntime = () => ({
  now: Date.now,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  rss: () => 4096,
});
const create = () => createLaunchTelemetry(id, fakeRuntime());
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

async function closeOnNextTick(recorder: ReturnType<typeof create>): Promise<ServerLaunchTelemetry | undefined> {
  const snapshot = recorder.close();
  await vi.advanceTimersByTimeAsync(50);
  return snapshot;
}

it.each([[50, [{ startAt: 1000, endAt: 1100 }]], [49, []]])("records the whole tick gap at the 100 ms boundary (%i)", async (jump, expected) => {
  const recorder = create();
  recorder.listen();
  vi.setSystemTime(1000 + jump);
  vi.advanceTimersByTime(50);
  expect((await closeOnNextTick(recorder))?.stalls).toEqual(expected);
});

it.each([[2_000, 31_000], [26_000, 36_000], [150_000, 160_000]])(
  "holds delivery until the window closes after a usable frame read at %i",
  async (usableAt, closeAt) => {
    const recorder = create();
    recorder.listen();
    await vi.advanceTimersByTimeAsync(usableAt - 1000);
    const delivered = vi.fn();
    void recorder.close(usableAt)?.then(delivered);
    await vi.advanceTimersByTimeAsync(closeAt - usableAt - 50);
    expect(delivered).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ launchId: id, listenAt: 1000, windowEndAt: closeAt }));
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("cannot hold the window past the minimum window with a usable frame later than the read", async () => {
  const recorder = create();
  recorder.listen();
  const snapshot = recorder.close(500_000);
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await snapshot)?.windowEndAt).toBe(31_000);
});

it("delivers window RPCs, startup tasks and marks, and ends a stall still open at close", async () => {
  const recorder = create();
  recorder.mark("configuration");
  let resolve!: () => void;
  const task = recorder.trackLaunchTask("warmup", new Promise<void>((done) => { resolve = done; }));
  expect(recorder.openRpc("ignored", 1000)).toBeUndefined();
  recorder.listen();
  const answered = recorder.openRpc("workspace.list", 1000);
  assert(answered, "an open window opens the request");
  recorder.openRpc("thread.list", 1000);
  recorder.answerRpc(answered, 12);
  const snapshot = recorder.close();
  vi.setSystemTime(1150);
  await vi.advanceTimersByTimeAsync(50);
  resolve();
  await task;
  expect(await snapshot).toMatchObject({ marks: [{ name: "configuration", at: 1000 }],
    rpcs: [{ method: "workspace.list", startAt: 1000, durationMs: 0, responseBytes: 12 }],
    unansweredRpcs: [{ method: "thread.list", startAt: 1000 }],
    tasks: [{ name: "warmup", startAt: 1000, endAt: null }], stalls: [{ startAt: 1000, endAt: 1200 }], windowEndAt: 1200 });
  recorder.mark("late");
  expect(recorder.openRpc("late", 1200)).toBeUndefined();
  expect(recorder.close()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("samples memory, caps answered and unanswered RPCs together and counts dropped ones", async () => {
  const recorder = create();
  recorder.listen();
  const opened = Array.from({ length: LAUNCH_RPC_LIMIT + 3 }, () => recorder.openRpc("settings.get", 1000));
  for (const rpc of opened.slice(1)) if (rpc) recorder.answerRpc(rpc, 8);
  vi.advanceTimersByTime(1000);
  const snapshot = await closeOnNextTick(recorder);
  expect(snapshot?.rpcs).toHaveLength(LAUNCH_RPC_LIMIT - 1);
  expect(snapshot?.unansweredRpcs).toHaveLength(1);
  expect(snapshot?.rpcsDropped).toBe(3);
  expect(snapshot?.memory).toEqual([{ at: 2000, rssBytes: 4096 }]);
});

it("delivers a window read 151 seconds after listen, when the server answers health at 40 seconds and the frame comes 111 seconds later", async () => {
  const recorder = create();
  recorder.listen();
  vi.advanceTimersByTime(151_000);
  const snapshot = recorder.close(152_000);
  await vi.advanceTimersByTimeAsync(LAUNCH_SETTLE_MS);
  expect((await snapshot)?.windowEndAt).toBe(162_000);
});

it("delivers a window desktop reads when it gives up after its slowest health answer", async () => {
  const recorder = create();
  recorder.listen();
  const lastHealthProbe = 3_000;
  const readAt = 1000 + SERVER_STARTUP_TIMEOUT_MS + lastHealthProbe + LAUNCH_USABLE_LIMIT_MS;
  vi.advanceTimersByTime(readAt - 1000);
  const snapshot = recorder.close();
  await vi.advanceTimersByTimeAsync(50);
  expect((await snapshot)?.windowEndAt).toBe(readAt + 50);
});

it("expires at the retention limit when nobody reads it", () => {
  const recorder = create();
  expect(recorder.close()).toBeUndefined();
  recorder.listen();
  vi.advanceTimersByTime(LAUNCH_RETENTION_MS - 1);
  expect(recorder.phase).toBe("window");
  vi.advanceTimersByTime(1);
  expect(recorder.phase).toBe("expired");
  expect(recorder.close()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([undefined, "not-a-uuid"])("is disabled without a valid launch ID (%s)", (launchId) => {
  const recorder = createLaunchTelemetry(launchId, fakeRuntime());
  recorder.listen();
  recorder.mark("ignored");
  expect(recorder.phase).toBe("disabled");
  expect(recorder.openRpc("ignored", 1000)).toBeUndefined();
  expect(recorder.close()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a tracked task rejection and records its settlement", async () => {
  const recorder = create();
  const error = new Error("failed task");
  const task = recorder.trackLaunchTask("failure", Promise.reject(error));
  await expect(task).rejects.toBe(error);
  recorder.listen();
  expect((await closeOnNextTick(recorder))?.tasks).toEqual([{ name: "failure", startAt: 1000, endAt: 1000 }]);
});

function request(recorder: ReturnType<typeof create>, query = "", token: string | null = "test-secret") {
  const req = new NodeHTTP.IncomingMessage(new NodeNet.Socket());
  req.method = "GET";
  req.url = `/__mcode/launch-telemetry${query}`;
  if (token) req.headers.authorization = `Bearer ${token}`;
  const res = new NodeHTTP.ServerResponse(req);
  const end = vi.spyOn(res, "end").mockImplementation(() => res);
  const handled = handleLaunchTelemetryRequest(req, res, "test-secret", recorder);
  return { handled, status: () => res.statusCode, ended: () => end.mock.calls.length > 0, body: () => end.mock.calls[0]?.[0] };
}

it("refuses unauthenticated, early and malformed reads without closing the window", () => {
  const recorder = create();
  expect(request(recorder, "", null).status()).toBe(401);
  expect(request(recorder).status()).toBe(410);
  recorder.listen();
  expect(request(recorder, "?usableAt=soon").status()).toBe(400);
  expect(request(recorder, "?usableAt=-5").status()).toBe(400);
  expect(recorder.phase).toBe("window");
});

it("holds an authenticated read until the window closes, then answers later reads with 410", async () => {
  const recorder = create();
  recorder.listen();
  const held = request(recorder, "?usableAt=2000");
  expect(held.handled).toBe(true);
  await vi.advanceTimersByTimeAsync(29_950);
  expect(held.ended()).toBe(false);
  await vi.advanceTimersByTimeAsync(50);
  expect(held.status()).toBe(200);
  expect(JSON.parse(String(held.body()))).toMatchObject({ launchId: id, windowEndAt: 31_000 });
  expect(request(recorder).status()).toBe(410);
});

it("answers a held read on the next tick once shutdown ends the window", async () => {
  const recorder = create();
  recorder.listen();
  const held = request(recorder, "?usableAt=2000");
  await vi.advanceTimersByTimeAsync(5_000);
  recorder.endNow();
  await vi.advanceTimersByTimeAsync(50);
  expect(held.status()).toBe(200);
  expect(JSON.parse(String(held.body()))).toMatchObject({ launchId: id, windowEndAt: 6_050 });
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves other routes alone and answers 404 when telemetry is disabled", () => {
  const recorder = createLaunchTelemetry(undefined, fakeRuntime());
  expect(request(recorder).status()).toBe(404);
  const other = new NodeHTTP.IncomingMessage(new NodeNet.Socket());
  other.method = "POST";
  other.url = "/__mcode/launch-telemetry";
  expect(handleLaunchTelemetryRequest(other, new NodeHTTP.ServerResponse(other), "test-secret", recorder)).toBe(false);
});
