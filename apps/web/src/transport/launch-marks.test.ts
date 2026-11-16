// @vitest-environment jsdom
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LAUNCH_USABLE_LIMIT_MS } from "@mcode/contracts/launch-telemetry";

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  document.body.innerHTML = "";
  delete window.desktopBridge;
  vi.useRealTimers();
});

it.each(["workspaces", "threads", "editor"])("waits for %s then reports the painted usable frame once", async (missing) => {
  const report = vi.fn();
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: { reportLaunchMark: report } });
  const { observeUsableLaunch } = await import("./launch-marks");
  const store = createStore(() => ({
    workspacesLoaded: missing !== "workspaces",
    threadSnapshotEpoch: missing === "threads" ? 0 : 1,
    activeThreadId: null,
  }));
  const editor = document.createElement("div");
  editor.setAttribute("data-lexical-editor", "true");
  editor.setAttribute("contenteditable", "true");
  if (missing !== "editor") document.body.append(editor);
  const dispose = observeUsableLaunch(store, Promise.resolve());
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(report).toHaveBeenCalledTimes(0);
  if (missing === "editor") document.body.append(editor);
  if (missing === "workspaces") store.setState({ workspacesLoaded: true });
  if (missing === "threads") store.setState({ threadSnapshotEpoch: 1 });
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  expect(report).toHaveBeenCalledTimes(0);
  vi.advanceTimersToNextFrame();
  expect(report.mock.calls.map(([name]) => name)).toEqual(["usable"]);
  store.setState({ threadSnapshotEpoch: 2 });
  document.body.append(document.createElement("span"));
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(report).toHaveBeenCalledTimes(1);
  dispose();
});

it("does no observation work without the desktop bridge", async () => {
  const { observeUsableLaunch, reportLaunchMark } = await import("./launch-marks");
  const subscribe = vi.fn(() => () => {});
  const getState = vi.fn(() => ({ workspacesLoaded: true, threadSnapshotEpoch: 1, activeThreadId: null }));
  observeUsableLaunch({ subscribe, getState }, Promise.resolve());
  reportLaunchMark("usable");
  expect(subscribe).toHaveBeenCalledTimes(0);
  expect(getState).toHaveBeenCalledTimes(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  [LAUNCH_USABLE_LIMIT_MS - 1_000, ["usable"]],
  [LAUNCH_USABLE_LIMIT_MS, []],
])("counts the usable limit from a slow server connection: ready %i ms after it reports %j", async (afterConnect, expected) => {
  const report = vi.fn();
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: { reportLaunchMark: report } });
  const { observeUsableLaunch } = await import("./launch-marks");
  const store = createStore(() => ({ workspacesLoaded: true, threadSnapshotEpoch: 1, activeThreadId: null }));
  let connect = () => {};
  const dispose = observeUsableLaunch(store, new Promise<void>((resolve) => { connect = resolve; }));

  await vi.advanceTimersByTimeAsync(LAUNCH_USABLE_LIMIT_MS + 10_000);
  connect();
  await vi.advanceTimersByTimeAsync(afterConnect);
  const editor = document.createElement("div");
  editor.setAttribute("data-lexical-editor", "true");
  editor.setAttribute("contenteditable", "true");
  document.body.append(editor);
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();

  expect(report.mock.calls.map(([name]) => name)).toEqual(expected);
  dispose();
});

it("stops observing when the server connection fails", async () => {
  const report = vi.fn();
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: { reportLaunchMark: report } });
  const { observeUsableLaunch } = await import("./launch-marks");
  const store = createStore(() => ({ workspacesLoaded: true, threadSnapshotEpoch: 1, activeThreadId: null }));
  observeUsableLaunch(store, Promise.reject(new Error("refused")));

  await vi.advanceTimersByTimeAsync(0);
  const editor = document.createElement("div");
  editor.setAttribute("data-lexical-editor", "true");
  editor.setAttribute("contenteditable", "true");
  document.body.append(editor);
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();

  expect(report).toHaveBeenCalledTimes(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for an open thread's transcript, not its loading shell or another thread", async () => {
  const report = vi.fn();
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: { reportLaunchMark: report } });
  const { observeUsableLaunch } = await import("./launch-marks");
  const store = createStore(() => ({ workspacesLoaded: true, threadSnapshotEpoch: 1, activeThreadId: "thread-1" }));
  const editor = document.createElement("div");
  editor.setAttribute("data-lexical-editor", "true");
  editor.setAttribute("contenteditable", "true");
  const other = document.createElement("div");
  other.dataset.conversationStage = "messages";
  other.dataset.threadId = "thread-2";
  const stage = document.createElement("div");
  stage.dataset.conversationStage = "transition";
  stage.dataset.threadId = "thread-1";
  document.body.append(editor, other, stage);
  const dispose = observeUsableLaunch(store, Promise.resolve());
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(report).toHaveBeenCalledTimes(0);
  stage.dataset.conversationStage = "messages";
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(report.mock.calls.map(([name]) => name)).toEqual(["usable"]);
  dispose();
});

it("reports each first-paint answer once under its launch mark", async () => {
  const report = vi.fn();
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: { reportLaunchMark: report } });
  const { reportLaunchResponse } = await import("./launch-marks");
  for (const method of ["workspace.list", "thread.listAll", "settings.get", "thread.get", "workspace.list"]) {
    reportLaunchResponse(method);
  }
  expect(report.mock.calls.map(([name]) => name)).toEqual(["workspaceListAnswered", "threadListAnswered", "settingsAnswered"]);
});
