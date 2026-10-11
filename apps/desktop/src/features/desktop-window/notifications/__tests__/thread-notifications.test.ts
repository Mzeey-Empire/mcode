import { describe, expect, it, vi } from "vitest";

import {
  parseThreadNotificationRequest,
  ThreadNotifications,
  type ThreadNotificationHandle,
} from "../thread-notifications.js";

interface FakeNotification extends ThreadNotificationHandle {
  readonly options: { title: string; body: string };
  readonly shown: boolean;
  readonly closed: boolean;
  emit(event: "click" | "close"): void;
}

function createFakeNotification(options: { title: string; body: string }): FakeNotification {
  const listeners = new Map<string, () => void>();
  let shown = false;
  let closed = false;
  return {
    options,
    get shown() { return shown; },
    get closed() { return closed; },
    on: (event, listener) => { listeners.set(event, listener); },
    show: () => { shown = true; },
    close: () => {
      closed = true;
      listeners.get("close")?.();
    },
    emit: (event) => listeners.get(event)?.(),
  };
}

function createSubject({ supported = true, minimized = false } = {}) {
  const window = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const created: FakeNotification[] = [];
  const subject = new ThreadNotifications({
    getMainWindow: () => window,
    notification: {
      isSupported: () => supported,
      create: (options) => {
        const notification = createFakeNotification(options);
        created.push(notification);
        return notification;
      },
    },
  });
  return { subject, window, created };
}

const finished = { tag: "thread-a", title: "Finished: Refactor auth", body: "Changed 3 files · feature-auth" };

describe("ThreadNotifications", () => {
  it("shows a notification with the requested title and body", () => {
    const { subject, created } = createSubject();

    subject.show(finished);

    expect(created.map(({ options, shown }) => ({ options, shown }))).toEqual([
      { options: { title: "Finished: Refactor auth", body: "Changed 3 files · feature-auth" }, shown: true },
    ]);
  });

  it("shows nothing where the platform has no notifications", () => {
    const { subject, created } = createSubject({ supported: false });

    subject.show(finished);

    expect(created).toEqual([]);
  });

  it("closes the previous notification for the same thread and keeps other threads", () => {
    const { subject, created } = createSubject();

    subject.show(finished);
    subject.show({ tag: "thread-b", title: "Failed: Fix flaky test", body: "main" });
    subject.show({ ...finished, title: "Approval required: Refactor auth", body: "feature-auth" });

    expect(created.map(({ options, closed }) => ({ title: options.title, closed }))).toEqual([
      { title: "Finished: Refactor auth", closed: true },
      { title: "Failed: Fix flaky test", closed: false },
      { title: "Approval required: Refactor auth", closed: false },
    ]);
  });

  it("restores a minimized window, focuses it, and sends the clicked thread", () => {
    const { subject, window, created } = createSubject({ minimized: true });

    subject.show(finished);
    created[0]!.emit("click");

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenCalledWith("notifications:clicked", "thread-a");
  });

  it("does not close a clicked notification again when its thread notifies next", () => {
    const { subject, created } = createSubject();

    subject.show(finished);
    created[0]!.emit("click");
    subject.show(finished);

    expect(created.map(({ closed }) => closed)).toEqual([false, false]);
  });
});

describe("parseThreadNotificationRequest", () => {
  it("accepts a valid request", () => {
    expect(parseThreadNotificationRequest({ ...finished, extra: true })).toEqual({
      tag: "thread-a",
      title: "Finished: Refactor auth",
      body: "Changed 3 files · feature-auth",
    });
  });

  it("rejects a title over 200 characters", () => {
    expect(() => parseThreadNotificationRequest({ ...finished, title: "x".repeat(201) }))
      .toThrow("Thread notification title exceeds 200 characters");
  });

  it("rejects a body over 300 characters", () => {
    expect(() => parseThreadNotificationRequest({ ...finished, body: "x".repeat(301) }))
      .toThrow("Thread notification body exceeds 300 characters");
  });

  it("rejects a missing tag and a non-object payload", () => {
    expect(() => parseThreadNotificationRequest({ title: "Finished: x", body: "" }))
      .toThrow("Thread notification tag must be a string");
    expect(() => parseThreadNotificationRequest("thread-a")).toThrow("Thread notification must be an object");
  });
});
