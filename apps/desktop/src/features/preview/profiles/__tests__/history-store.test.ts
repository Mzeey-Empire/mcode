import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserHistoryStore } from "../history-store.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const image = { resize: vi.fn(() => ({ toJPEG: vi.fn(() => jpeg) })) };

class Guest extends NodeEvents.EventEmitter {
  public url = "about:blank";
  public destroyed = false;
  public capturePage = vi.fn(async () => image);
  public constructor(public readonly id: number) { super(); }
  public getURL(): string { return this.url; }
  public getTitle(): string { return "Fixture"; }
  public isDestroyed(): boolean { return this.destroyed; }
  public navigate(url: string): void {
    this.emit("did-start-navigation", {}, url, false, true);
    this.url = url;
    this.emit("did-navigate", {}, url);
  }
}

let root: string;
let store: BrowserHistoryStore;
let guest: Guest;
const removed = new Set<string>();
const capturePage = vi.fn(async (target: Parameters<NonNullable<ConstructorParameters<typeof BrowserHistoryStore>[0]["capturePage"]>>[0]) => target.capturePage());

function owner(): BrowserHistoryStore {
  return new BrowserHistoryStore({
    userDataPath: () => root,
    isRemoved: (id) => removed.has(id),
    now: () => Date.now(), setTimeout, clearTimeout, capturePage,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.clearAllMocks();
  removed.clear();
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-history-"));
  store = owner();
  guest = new Guest(1);
  store.observe(A, guest);
});

afterEach(() => {
  store.forget(A);
  store.forget(B);
  vi.useRealTimers();
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("BrowserHistoryStore", () => {
  it("caps at 50, deduplicates identity, strips credentials and fragments, and persists newest first", () => {
    for (let index = 0; index < 55; index++) {
      vi.setSystemTime(100_000 + index);
      store.record(A, `http://localhost/page/${index}`);
    }
    vi.setSystemTime(101_000);
    store.record(A, "http://user:password@localhost/page/5?b=2&utm_source=x&a=1#fragment", "x".repeat(250));
    vi.setSystemTime(102_000);
    store.record(A, "http://localhost/page/5?a=1&b=2&utm_campaign=y#other", "Updated");
    const entries = store.list(A).entries;
    expect(entries).toHaveLength(50);
    expect(entries[0]).toEqual({ url: "http://localhost/page/5?a=1&b=2&utm_campaign=y", title: "Updated", faviconUrl: null, lastVisitedAt: 102_000 });
    expect(entries.slice(1).map((entry) => entry.url)).toEqual(Array.from({ length: 49 }, (_, index) => `http://localhost/page/${54 - index}`));
    expect(owner().list(A).entries).toEqual(entries);
    expect(store.list(B)).toEqual({ entries: [], thumbnails: [] });
    expect(NodeFS.readdirSync(NodePath.join(root, "browser-profiles", A))).toEqual(["history.json"]);
  });

  it("bounds metadata, ignores unsafe URLs, and changes recency only on main-frame page identity changes", () => {
    guest.navigate("http://user:secret@localhost/a#fragment");
    guest.emit("page-title-updated", {}, "t".repeat(300));
    guest.emit("page-favicon-updated", {}, ["https://user:secret@example.test/icon#fragment"]);
    expect(store.list(A).entries).toEqual([{ url: "http://localhost/a", title: "t".repeat(240), faviconUrl: "https://example.test/icon", lastVisitedAt: 100_000 }]);
    vi.setSystemTime(110_000);
    guest.emit("did-navigate-in-page", {}, "http://localhost/a#second", true);
    guest.emit("did-navigate-in-page", {}, "http://localhost/frame", false);
    expect(store.list(A).entries[0]?.lastVisitedAt).toBe(100_000);
    guest.url = "http://localhost/b";
    guest.emit("did-navigate-in-page", {}, guest.url, true);
    for (const url of ["about:blank", "data:text/plain,secret", "file:///secret", "javascript:alert(1)", `http://localhost/${"x".repeat(4096)}`]) store.record(A, url);
    expect(store.list(A).entries.map((entry) => entry.url)).toEqual(["http://localhost/b", "http://localhost/a"]);
    store.remove(A, "http://localhost/a?utm_source=removed#fragment");
    guest.url = "http://localhost/a";
    guest.emit("page-title-updated", {}, "late title");
    expect(owner().list(A).entries.map((entry) => entry.url)).toEqual(["http://localhost/b"]);
    expect(() => store.list("../escape")).toThrow(TypeError);
    expect(() => store.remove(A, "file:///secret")).toThrow(TypeError);
  });

  it.each(["{broken", "null", '[{"url":"http://localhost","lastVisitedAt":"yesterday"}]'])("treats malformed persisted history as empty: %s", (contents) => {
    const directory = NodePath.join(root, "browser-profiles", A);
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, "history.json"), contents);
    expect(store.list(A)).toEqual({ entries: [], thumbnails: [] });
    guest.navigate("http://localhost/recovered");
    expect(owner().list(A).entries.map((entry) => entry.url)).toEqual(["http://localhost/recovered"]);
  });

  it("captures at 1.5 seconds, shares a 60-second origin cooldown across tabs, and never repeats while idle", async () => {
    guest.navigate("http://localhost:5173/a");
    guest.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(1499);
    expect(capturePage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(image.resize).toHaveBeenCalledWith({ width: 320 });
    expect(image.resize.mock.results[0]?.value.toJPEG).toHaveBeenCalledWith(70);
    const expected = [{ origin: "http://localhost:5173", capturedAt: 101_500, dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}` }];
    expect(store.list(A).thumbnails).toEqual(expected);
    expect(owner().list(A).thumbnails).toEqual(expected);
    const second = new Guest(2);
    store.observe(A, second);
    second.navigate("http://localhost:5173/b");
    await store.captureGuest(second.id);
    expect(capturePage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    await store.captureGuest(guest.id);
    expect(capturePage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await store.captureGuest(second.id);
    expect(capturePage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(capturePage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["http://localhost:3000", "http://127.2.3.4", "http://192.168.1.2", "http://[::1]:3000", "http://[2001:db8::1]"])("captures a local or IP literal origin: %s", async (origin) => {
    guest.navigate(`${origin}/fixture`);
    await store.captureGuest(guest.id);
    expect(store.list(A).thumbnails.map((thumbnail) => thumbnail.origin)).toEqual([origin]);
  });

  it("preserves the capture cooldown after reload and waits for an existing capture before closing", async () => {
    guest.navigate("http://localhost/a");
    let finish: (value: typeof image) => void = () => { throw new Error("capture not started"); };
    guest.capturePage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loading = store.captureGuest(guest.id);
    let closed = false;
    const closing = store.captureGuest(guest.id).then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(capturePage).toHaveBeenCalledTimes(1);
    finish(image);
    await Promise.all([loading, closing]);
    expect(closed).toBe(true);
    store.forget(A);
    const restarted = owner();
    const dispose = restarted.observe(A, guest);
    await restarted.captureGuest(guest.id);
    expect(capturePage).toHaveBeenCalledTimes(1);
    dispose();
  });

  it.each(["https://example.com", "http://localhost.attacker.test", "file:///fixture", "about:blank"])("does not capture or schedule a timer for %s", async (url) => {
    guest.navigate(url);
    guest.emit("did-finish-load");
    await store.captureGuest(guest.id);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(capturePage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels load timers on navigation and destruction, and discards captures that cross a navigation", async () => {
    guest.navigate("http://localhost/a");
    guest.emit("did-finish-load");
    guest.navigate("https://example.test/");
    await vi.advanceTimersByTimeAsync(1500);
    expect(capturePage).not.toHaveBeenCalled();
    guest.navigate("http://localhost/a");
    let resolveCapture: (value: typeof image) => void = () => { throw new Error("capture not started"); };
    guest.capturePage.mockImplementationOnce(() => new Promise((resolve) => { resolveCapture = resolve; }));
    const pending = store.captureGuest(guest.id);
    guest.navigate("https://example.test/");
    resolveCapture(image);
    await pending;
    expect(store.list(A).thumbnails).toEqual([]);
    guest.navigate("http://localhost/a");
    guest.emit("did-finish-load");
    guest.destroyed = true;
    guest.emit("destroyed");
    expect(vi.getTimerCount()).toBe(0);
    expect(guest.eventNames()).toEqual([]);
  });
});
