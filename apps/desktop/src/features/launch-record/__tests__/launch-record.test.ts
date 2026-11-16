import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLaunchRecord } from "../launch-record.js";

const launchId = "d98138cd-a571-49b8-ae76-8ec6507c3201";
const telemetry = { launchId, migrated: true, marks: [{ name: "database writer ready", at: 1000 }],
  listenAt: 1000, windowEndAt: 31_000, rpcs: [], unansweredRpcs: [], rpcsDropped: 0, tasks: [], stalls: [], memory: [] };
function setup({ body = {} as unknown, t0 = 900 as number | null } = {}) {
  const write = vi.fn();
  const fetch = vi.fn(async (_usableAt?: number) => new Response(JSON.stringify(body)));
  const recorder = createLaunchRecord({ launchId, appVersion: "1.0", t0, bootAt: 0, mainModuleStart: 1000,
    now: Date.now, setTimeout, clearTimeout, fetch, write });
  return { recorder, write, fetch };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

it("asks the server to hold its window from the usable frame and writes once it answers", async () => {
  const { recorder, write, fetch } = setup({ body: telemetry });
  await vi.advanceTimersByTimeAsync(500);
  recorder.serverHealthy("spawned");
  recorder.rendererMark(1, 1, "usable", 2000);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledWith(2000);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ writtenBecause: "window-ended", serverMode: "spawned",
    main: { mainModuleStart: 1000, serverHealthy: 1500 }, renderer: { usable: 2000 },
    serverTelemetry: telemetry, serverTelemetryError: null });
});

it("waits through a slow server start, then reads the window 120 seconds after health while the handover stalls", async () => {
  const { recorder, write, fetch } = setup({ body: telemetry });
  await vi.advanceTimersByTimeAsync(600_000);
  recorder.serverHealthy("spawned");
  await vi.advanceTimersByTimeAsync(119_999);
  expect(write).toHaveBeenCalledTimes(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledWith(undefined);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ writtenBecause: "usable-timeout", serverTelemetry: telemetry,
    main: { serverHealthy: 601_000 } });
});

it("keeps the first health answer, so a server restarted during the launch cannot extend the wait", async () => {
  const { recorder, write } = setup({ body: telemetry });
  recorder.serverHealthy("spawned");
  await vi.advanceTimersByTimeAsync(60_000);
  recorder.serverHealthy("reused");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ writtenBecause: "usable-timeout", serverMode: "spawned",
    main: { serverHealthy: 1000 } });
  expect(vi.getTimerCount()).toBe(0);
});

it("never fetches a reused server and preserves unmeasured creation time", async () => {
  const { recorder, fetch, write } = setup({ t0: null });
  recorder.serverHealthy("reused");
  recorder.rendererMark(1, 1, "usable", 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(0);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ t0: null, serverMode: "reused", writtenBecause: "window-ended",
    serverTelemetry: null, serverTelemetryError: null });
});

it.each([["different", "launch-id-mismatch"], [null, "invalid-schema"]])("rejects mismatched and invalid telemetry (%s)", async (id, reason) => {
  const body = id === null ? {} : { ...telemetry, launchId: "f76d2b73-1b94-413f-a905-fc11d8bc480c" };
  const { recorder, write } = setup({ body });
  recorder.rendererMark(1, 1, "usable", 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ serverTelemetry: null, serverTelemetryError: reason });
});

it.each(["http", "network"])("writes a short reason after %s failure", async (failure) => {
  const { recorder, write, fetch } = setup();
  fetch.mockImplementation(async () => {
    if (failure === "network") throw new Error("private connection detail");
    return new Response("private response body", { status: 410 });
  });
  recorder.rendererMark(1, 1, "usable", 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ serverTelemetry: null,
    serverTelemetryError: failure === "http" ? "http-status" : "fetch-failed" });
});

it("drops untrusted renderer marks and keeps the first valid value", () => {
  const { recorder, write } = setup();
  recorder.rendererMark(2, 1, "usable", 1000);
  recorder.rendererMark(1, 1, "unknown", 1000);
  recorder.rendererMark(1, 1, "usable", NaN);
  recorder.rendererMark(1, 1, "usable", Infinity);
  recorder.rendererMark(1, 1, "usable", -1);
  recorder.rendererMark(1, 1, "usable", 1234);
  recorder.rendererMark(1, 1, "usable", 5678);
  recorder.quit();
  expect(write.mock.calls[0]?.[0].renderer).toEqual({ usable: 1234 });
});

it("writes once when quit races the held fetch", async () => {
  const { recorder, write, fetch } = setup();
  let resolve!: (response: Response) => void;
  fetch.mockImplementation(() => new Promise((done) => { resolve = done; }));
  recorder.rendererMark(1, 1, "usable", 1000);
  recorder.quit();
  resolve(new Response(JSON.stringify(telemetry)));
  await vi.advanceTimersByTimeAsync(0);
  recorder.quit();
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ writtenBecause: "quit", serverTelemetry: null });
});

it("writes a startup failure immediately without fetching, and stops the give-up timer", () => {
  const { recorder, write, fetch } = setup();
  recorder.serverHealthy("spawned");
  recorder.failed();
  recorder.quit();
  expect(fetch).toHaveBeenCalledTimes(0);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[0]).toMatchObject({ serverMode: "spawned", writtenBecause: "startup-failed" });
  expect(vi.getTimerCount()).toBe(0);
});

it("records the boot classification that arrives before the write", () => {
  const { recorder, write } = setup();
  recorder.bootClassified(true);
  recorder.quit();
  expect(write.mock.calls[0]?.[0].firstSinceBoot).toBe(true);
});
