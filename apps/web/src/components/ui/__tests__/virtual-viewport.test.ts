// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualViewport, type ViewportPosition, type VirtualHost, type VirtualRow } from "../virtual-viewport";

class SilentObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const nextFrame = () => vi.advanceTimersByTimeAsync(16);
const rows: VirtualRow[] = Array.from({ length: 40 }, (_, index) => ({ id: `r${index}`, height: 40 }));

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce, media: query, addEventListener() {}, removeEventListener() {} }));
}

describe("VirtualViewport additions", () => {
  let view: VirtualViewport;
  let hosts: readonly VirtualHost[];
  let animate: ReturnType<typeof vi.fn<HTMLElement["animate"]>>;

  function animatedIds(): string[] {
    return animate.mock.contexts.map((element) => (element as HTMLElement).getAttribute("data-virtual-key") ?? "");
  }

  function hostElement(id: string): HTMLDivElement {
    const host = hosts.find((candidate) => candidate.id === id);
    if (!host) throw new Error(`${id} is not visible`);
    return host.element;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    vi.stubGlobal("ResizeObserver", SilentObserver);
    stubReducedMotion(false);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    animate = vi.fn<HTMLElement["animate"]>();
    HTMLElement.prototype.animate = animate;
    const container = document.createElement("div");
    document.body.append(container);
    hosts = [];
    view = new VirtualViewport(container, (next) => { hosts = next; }, () => {}, { ariaLabel: "Rows" });
    view.setRows(rows);
  });

  afterEach(() => {
    view.destroy();
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  });

  it("slides a reordered visible host once from its old offset", () => {
    const moved = hostElement("r1");
    view.setRows([rows[1]!, rows[0]!, ...rows.slice(2)], { flip: true });

    expect(animate.mock.contexts.filter((element) => element === moved)).toHaveLength(1);
    const call = animate.mock.calls[animate.mock.contexts.indexOf(moved)];
    expect(call?.[0]).toEqual([{ transform: "translateY(40px)" }, { transform: "translateY(0)" }]);
    expect(animatedIds().sort()).toEqual(["r0", "r1"]);
  });

  it("does not animate a host that enters view", () => {
    expect(hosts.some((host) => host.id === "r39")).toBe(false);
    view.setRows([rows[39]!, ...rows.slice(0, 39)], { flip: true });

    expect(hosts.some((host) => host.id === "r39")).toBe(true);
    expect(animatedIds()).not.toContain("r39");
    expect(animatedIds()).toContain("r0");
  });

  it("animates nothing without flip or under reduced motion", () => {
    view.setRows([rows[1]!, rows[0]!, ...rows.slice(2)]);
    expect(animate).not.toHaveBeenCalled();

    stubReducedMotion(true);
    view.setRows(rows, { flip: true });
    expect(animate).not.toHaveBeenCalled();
  });

  it("calls onLayout once per frame for several scroll events", async () => {
    const listener = vi.fn();
    view.onLayout(listener);
    for (const top of [40, 80, 120]) {
      view.viewport.scrollTop = top;
      view.viewport.dispatchEvent(new Event("scroll"));
    }
    expect(listener).not.toHaveBeenCalled();

    await nextFrame();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops calling onLayout after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = view.onLayout(listener);
    unsubscribe();
    view.viewport.dispatchEvent(new Event("scroll"));
    await nextFrame();

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the flow host out of the published hosts and hides it when its row is gone", () => {
    view.destroy();
    const container = document.createElement("div");
    document.body.append(container);
    view = new VirtualViewport(container, (next) => { hosts = next; }, () => {}, { ariaLabel: "Rows", flowHostId: "bar" });
    view.setRows([rows[0]!, { id: "bar", height: 32 }, rows[1]!]);

    expect(view.flowHost?.style.position).toBe("sticky");
    expect(view.flowHost?.style.display).toBe("flow-root");
    expect(hosts.map((host) => host.id)).toEqual(["r0", "r1"]);

    view.setRows([rows[0]!, rows[1]!]);
    expect(view.flowHost?.style.display).toBe("none");
  });

  it("takes the flow host's empty wrapper out of flow so the content is not stacked twice", () => {
    view.destroy();
    const container = document.createElement("div");
    document.body.append(container);
    view = new VirtualViewport(container, (next) => { hosts = next; }, () => {}, { ariaLabel: "Rows", flowHostId: "bar" });
    view.setRows([rows[0]!, { id: "bar", height: 32 }, rows[1]!]);

    const wrappers = [...container.querySelectorAll<HTMLElement>("[data-index]")];
    expect(wrappers.map((wrapper) => wrapper.dataset.index)).toEqual(["0", "1", "2"]);
    expect(wrappers.map((wrapper) => wrapper.style.position)).toEqual(["absolute", "absolute", "absolute"]);
  });

  it("hands a released move back to the reading row so later row changes stop chasing the target", () => {
    view.destroy();
    const container = document.createElement("div");
    document.body.append(container);
    const positions: ViewportPosition[] = [];
    view = new VirtualViewport(container, (next) => { hosts = next; }, (position) => positions.push(position), { ariaLabel: "Rows" });
    view.setRows(rows);

    view.moveTo({ kind: "target", key: "r10", align: "start" }, false, { release: true });
    view.setRows(rows.slice(1));

    expect(positions.at(-1)?.kind).toBe("reading");
  });

  it("keeps an unreleased target across row changes", () => {
    view.destroy();
    const container = document.createElement("div");
    document.body.append(container);
    const positions: ViewportPosition[] = [];
    view = new VirtualViewport(container, (next) => { hosts = next; }, (position) => positions.push(position), { ariaLabel: "Rows" });
    view.setRows(rows);

    view.moveTo({ kind: "target", key: "r10", align: "center" });
    view.setRows(rows.slice(1));

    expect(positions.at(-1)).toEqual({ kind: "target", key: "r10", align: "center" });
  });

  it("reports the scroller's visible height", () => {
    expect(view.clientHeight).toBe(200);
  });
});
