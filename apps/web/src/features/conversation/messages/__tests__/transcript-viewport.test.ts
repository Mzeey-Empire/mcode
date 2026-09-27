import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptViewport, type TranscriptHost, type TranscriptPosition } from "../transcript-viewport";
import { VirtualViewport } from "@/components/ui/virtual-viewport";

class LayoutObserver implements ResizeObserver {
  static instances: LayoutObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) { LayoutObserver.instances.push(this); }
  observe(element: Element): void { this.observed.add(element); }
  unobserve(element: Element): void { this.observed.delete(element); }
  disconnect(): void { this.observed.clear(); }
  static resize(element: Element, height: number): void {
    const size = [{ blockSize: height, inlineSize: 600 }];
    const entry: ResizeObserverEntry = {
      target: element, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size,
      contentRect: new DOMRect(0, 0, 600, height),
    };
    for (const observer of this.instances) {
      if (observer.observed.has(element)) observer.callback([entry], observer);
    }
  }
}

/** Measurement application is deferred one frame to avoid ResizeObserver loops. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("transcript viewport", () => {
  let view: VirtualViewport;
  let hosts: readonly TranscriptHost[];
  let position: TranscriptPosition;
  let publications: number;
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: String(index), height: 100 }));

  beforeEach(() => {
    LayoutObserver.instances = [];
    vi.stubGlobal("ResizeObserver", LayoutObserver);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return Number.parseFloat(this.firstElementChild instanceof HTMLElement ? this.firstElementChild.style.height : "0") || 200;
    });
    const container = document.createElement("div");
    document.body.append(container);
    hosts = [];
    publications = 0;
    position = { kind: "end" };
    view = new TranscriptViewport(container, (next) => { hosts = next; publications += 1; }, (next) => { position = next; });
    view.setRows(rows);
  });

  afterEach(() => {
    view.destroy();
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("supports a non-chat list without initial or automatic end following", () => {
    view.destroy();
    const container = document.createElement("div");
    document.body.append(container);
    view = new VirtualViewport(container, (next) => { hosts = next; }, (next) => { position = next; }, { ariaLabel: "Files" });
    view.setRows(rows);
    expect(view.viewport.scrollTop).toBe(0);
    expect(hosts.some((host) => host.id === "0")).toBe(true);
    view.viewport.scrollTop = 1800;
    view.viewport.dispatchEvent(new Event("scroll"));
    view.setRows([...rows, { id: "20", height: 100 }]);
    expect(view.viewport.scrollTop).toBe(1800);
    expect(position).toEqual({ kind: "reading", key: "18", offset: 0 });
  });

  it("follows repeated streaming measurements, including shrinking content", async () => {
    expect(view.viewport.scrollTop).toBe(1800);
    const tail = hosts.find((host) => host.id === "19")!;
    LayoutObserver.resize(tail.element, 180);
    await nextFrame();
    expect(view.viewport.scrollTop).toBe(1880);
    LayoutObserver.resize(tail.element, 240);
    await nextFrame();
    expect(view.viewport.scrollTop).toBe(1940);
    LayoutObserver.resize(tail.element, 120);
    await nextFrame();
    expect(view.viewport.scrollTop).toBe(1820);
    expect(position).toEqual({ kind: "end" });
  });

  it("applies every measurement delivered within the same frame", async () => {
    const tail = hosts.find((host) => host.id === "19")!;
    const penultimate = hosts.find((host) => host.id === "18")!;
    LayoutObserver.resize(tail.element, 180);
    LayoutObserver.resize(penultimate.element, 140);
    await nextFrame();
    expect(view.viewport.scrollTop).toBe(1920);
    expect(position).toEqual({ kind: "end" });
  });

  it("does not publish unchanged visible hosts during repeated positioning", () => {
    const baseline = publications;
    const visible = hosts;
    for (let index = 0; index < 10; index += 1) view.moveTo({ kind: "end" });
    expect(publications - baseline).toBe(0);
    expect(hosts).toBe(visible);
  });

  it("publishes changed ranges and replacement hosts after release", () => {
    const original = hosts.find((host) => host.id === "19")!;
    const baseline = publications;
    view.moveTo({ kind: "reading", key: "0", offset: 0 });
    expect(publications).toBeGreaterThan(baseline);
    expect(hosts.some((host) => host.id === "19")).toBe(false);
    view.releaseHosts(hosts);
    view.moveTo({ kind: "end" });
    const replacement = hosts.find((host) => host.id === "19")!;
    expect(replacement.element).not.toBe(original.element);
    expect(replacement.element.isConnected).toBe(true);
  });

  it("holds a reading row when an earlier row grows and history is prepended", async () => {
    view.moveTo({ kind: "reading", key: "9", offset: 25 });
    const anchor = hosts.find((host) => host.id === "9")!;
    const earlier = hosts.find((host) => host.id === "1")!;
    LayoutObserver.resize(earlier.element, 160);
    await nextFrame();
    expect(view.viewport.scrollTop).toBe(985);
    view.setRows([{ id: "older-1", height: 100 }, { id: "older-2", height: 100 }, ...rows]);
    expect(view.viewport.scrollTop).toBe(1185);
    expect(hosts.find((host) => host.id === "9")?.element).toBe(anchor.element);
    expect(position).toEqual({ kind: "reading", key: "9", offset: 25 });
  });

  it("pins the reading row to its scrolled screen position while prepended rows settle", () => {
    const tops = new Map(rows.map((row, index) => [row.id, index * 100]));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const key = this.getAttribute("data-transcript-key");
      const contentTop = key === null ? 0 : tops.get(key) ?? 0;
      return new DOMRect(0, contentTop - view.viewport.scrollTop, 600, 100);
    });
    view.moveTo({ kind: "reading", key: "9", offset: 25 });
    expect(view.viewport.scrollTop).toBe(925);
    const anchor = hosts.find((host) => host.id === "9")!;
    // Prepended rows mount at provisional heights but really measure 300 each.
    for (const [id, top] of tops) tops.set(id, top + 400);
    view.setRows([{ id: "older-1", height: 100 }, { id: "older-2", height: 100 }, ...rows]);
    expect(anchor.element.getBoundingClientRect().top).toBe(-25);
    expect(view.viewport.scrollTop).toBe(1325);
    // A later measurement pass pushes the row again; the pin still wins.
    for (const [id, top] of tops) tops.set(id, top + 100);
    view.setRows([{ id: "older-1", height: 100 }, { id: "older-2", height: 100 }, ...rows]);
    expect(anchor.element.getBoundingClientRect().top).toBe(-25);
    expect(view.viewport.scrollTop).toBe(1425);
  });

  it("preserves the reading row when history fills a previously short viewport", () => {
    const recent = [{ id: "recent", height: 120 }];
    view.setRows(recent);
    view.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
    view.setRows([{ id: "older", height: 300 }, ...recent]);
    expect(view.rowTop("recent")).toBe(0);
    expect(position).toEqual({ kind: "reading", key: "recent", offset: 0 });
    view.moveTo({ kind: "end" });
    expect(view.viewport.scrollTop).toBe(220);
    expect(view.viewport.scrollHeight).toBe(420);
  });

  it("keeps every visible host attached when expanded rows move across the rendered range", () => {
    view.moveTo({ kind: "reading", key: "9", offset: 25 });
    const children = Array.from({ length: 40 }, (_, index) => ({ id: `tool-${index}`, height: 30 }));
    for (const next of [
      [...rows.slice(0, 3), ...children, ...rows.slice(3)],
      rows,
      [{ id: "older", height: 100 }, ...rows],
    ]) {
      view.setRows(next);
      view.releaseHosts(hosts);
      for (const host of hosts) {
        expect(host.element.parentElement?.getAttribute("data-id"), host.id).toBe(host.id);
      }
    }
  });

  it("does not resume tail following after an upward gesture and an append", () => {
    view.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    view.viewport.scrollTop = 1700;
    view.viewport.dispatchEvent(new Event("scroll"));
    view.setRows([...rows, { id: "20", height: 100 }]);
    expect(view.viewport.scrollTop).toBe(1700);
    expect(position).toEqual({ kind: "reading", key: "17", offset: 0 });
    view.moveTo({ kind: "end" });
    expect(view.viewport.scrollTop).toBe(1900);
  });

  it("keeps an unmounted navigation target centered as its height resolves", async () => {
    view.moveTo({ kind: "target", key: "1", align: "center" });
    expect(view.viewport.scrollTop).toBe(50);
    const target = hosts.find((host) => host.id === "1")!;
    LayoutObserver.resize(target.element, 300);
    await nextFrame();
    expect(view.viewport.scrollTop).toBe(150);
    expect(view.rowBottom("1")).toBe(250);
  });

  it("keeps tail following when a row control receives pointer or keyboard input", async () => {
    const tail = hosts.find((host) => host.id === "19")!;
    const button = document.createElement("button");
    tail.element.append(button);
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    LayoutObserver.resize(tail.element, 180);
    await nextFrame();
    expect(view.viewport.scrollTop).toBe(1880);
    expect(position).toEqual({ kind: "end" });
  });

  it("anchors a disclosure before its content expands and collapses", async () => {
    const tail = hosts.find((host) => host.id === "19")!;
    const button = document.createElement("button");
    button.setAttribute("aria-expanded", "false");
    tail.element.append(button);
    const before = view.rowTop("19");
    button.click();
    LayoutObserver.resize(tail.element, 180);
    await nextFrame();
    expect(view.rowTop("19")).toBe(before);
    expect(position).toEqual({ kind: "reading", key: "19", offset: -100 });
    button.setAttribute("aria-expanded", "true");
    button.click();
    LayoutObserver.resize(tail.element, 100);
    await nextFrame();
    expect(view.rowTop("19")).toBe(before);
  });

  it("cancels smooth navigation when the user scrolls", async () => {
    vi.useFakeTimers();
    view.moveTo({ kind: "reading", key: "1", offset: 0 });
    view.moveTo({ kind: "end" }, true);
    await vi.advanceTimersByTimeAsync(80);
    expect(view.viewport.scrollTop).toBeGreaterThan(100);
    expect(view.viewport.scrollTop).toBeLessThan(1800);
    view.viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    const interruptedTop = view.viewport.scrollTop;
    await vi.advanceTimersByTimeAsync(400);
    expect(view.viewport.scrollTop).toBe(interruptedTop);
    expect(position.kind).toBe("reading");
  });

  it("resolves smooth navigation to the measured target", async () => {
    vi.useFakeTimers();
    view.moveTo({ kind: "reading", key: "1", offset: 0 });
    view.moveTo({ kind: "end" }, true);
    await vi.advanceTimersByTimeAsync(300);
    expect(view.viewport.scrollTop).toBe(1800);
    expect(position).toEqual({ kind: "end" });
  });

  it("jumps immediately when reduced motion is requested", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue({ ...media, matches: true });
    view.moveTo({ kind: "reading", key: "1", offset: 0 });
    view.moveTo({ kind: "end" }, true);
    expect(view.viewport.scrollTop).toBe(1800);
    expect(position).toEqual({ kind: "end" });
  });
});
