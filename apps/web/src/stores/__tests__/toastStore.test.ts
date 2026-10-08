import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_LIFETIME_MS, useToastStore } from "../toastStore";

const store = () => useToastStore.getState();
const titles = () => store().toasts.map((toast) => toast.title);

beforeEach(() => {
  vi.useFakeTimers();
  for (const toast of store().toasts) store().dismiss(toast.id);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toastStore", () => {
  it("keeps three toasts, newest on top, and drops the oldest", () => {
    for (const title of ["one", "two", "three", "four"]) store().show({ kind: "failed", title });

    expect(titles()).toEqual(["four", "three", "two"]);
  });

  it("hides finished and info toasts after 8s and keeps needs-you and failed", () => {
    for (const kind of ["finished", "needs-you", "failed", "info"] as const) store().show({ kind, title: kind });

    vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1);
    expect(store().toasts).toHaveLength(3);
    expect(titles()).toEqual(["info", "failed", "needs-you"]);

    vi.advanceTimersByTime(1);
    expect(titles()).toEqual(["failed", "needs-you"]);

    vi.advanceTimersByTime(60_000);
    expect(titles()).toEqual(["failed", "needs-you"]);
  });

  it("keeps a finished toast while hovered and hides it after the remaining time", () => {
    const id = store().show({ kind: "finished", title: "Refine navigation" });
    vi.advanceTimersByTime(5_000);
    store().pause(id);
    vi.advanceTimersByTime(60_000);
    expect(titles()).toEqual(["Refine navigation"]);

    store().resume(id);
    vi.advanceTimersByTime(2_999);
    expect(titles()).toEqual(["Refine navigation"]);
    vi.advanceTimersByTime(1);
    expect(store().toasts).toEqual([]);
  });

  it("replaces a live toast with the same dedupe key in place", () => {
    const first = store().show({ kind: "needs-you", title: "Fix focus ring", meta: "Approval required · 14:35", dedupeKey: "thread-a" });
    store().show({ kind: "failed", title: "Bump Electron" });
    const second = store().show({ kind: "finished", title: "Fix focus ring", meta: "Finished · 14:40", dedupeKey: "thread-a" });

    expect(second).toBe(first);
    expect(store().toasts).toMatchObject([
      { title: "Bump Electron" },
      { id: first, kind: "finished", meta: "Finished · 14:40", dedupeKey: "thread-a" },
    ]);
  });

  it("gives a replaced toast the lifetime of its new kind", () => {
    store().show({ kind: "finished", title: "a", dedupeKey: "thread-a" });
    vi.advanceTimersByTime(7_000);
    store().show({ kind: "failed", title: "a", dedupeKey: "thread-a" });
    vi.advanceTimersByTime(60_000);

    expect(store().toasts).toMatchObject([{ kind: "failed" }]);
  });

  it("keeps a toast replaced under the pointer paused", () => {
    const id = store().show({ kind: "needs-you", title: "a", dedupeKey: "thread-a" });
    store().pause(id);
    store().show({ kind: "finished", title: "a", dedupeKey: "thread-a" });
    vi.advanceTimersByTime(60_000);
    expect(titles()).toEqual(["a"]);

    store().resume(id);
    vi.advanceTimersByTime(TOAST_LIFETIME_MS);
    expect(store().toasts).toEqual([]);
  });

  it("dismissByKey removes the keyed toast, cancels its timer and leaves the rest", () => {
    store().show({ kind: "failed", title: "other" });
    store().show({ kind: "finished", title: "keyed", dedupeKey: "thread-a" });
    store().dismissByKey("thread-a");
    expect(titles()).toEqual(["other"]);

    const fresh = store().show({ kind: "finished", title: "fresh", dedupeKey: "thread-a" });
    vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1);
    expect(store().toasts.find((toast) => toast.id === fresh)).toBeDefined();
  });

  it("dismissByKey with no matching toast changes nothing", () => {
    store().show({ kind: "failed", title: "other", dedupeKey: "thread-b" });
    const before = store().toasts;
    store().dismissByKey("thread-a");

    expect(store().toasts).toBe(before);
  });

  it("dismiss cancels the toast's timer", () => {
    const id = store().show({ kind: "finished", title: "a" });
    store().dismiss(id);
    const later = store().show({ kind: "failed", title: "b" });
    vi.advanceTimersByTime(TOAST_LIFETIME_MS);

    expect(store().toasts.map((toast) => toast.id)).toEqual([later]);
  });
});
