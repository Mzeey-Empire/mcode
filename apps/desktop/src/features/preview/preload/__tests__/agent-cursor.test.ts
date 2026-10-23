// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuestAgentCursor, GUEST_AGENT_CURSOR_IDLE_MS } from "../agent-cursor.js";

const mark = (): HTMLElement | null => document.querySelector("mcode-agent-cursor");

describe("guest agent cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.innerHTML = "<head></head><body></body>";
  });

  it("draws an inert mark at the agent's viewport point", () => {
    const cursor = createGuestAgentCursor(document);

    cursor.show({ phase: "move", x: 120, y: 48 });

    const element = mark();
    expect(element?.getAttribute("aria-hidden")).toBe("true");
    expect(element?.style.pointerEvents).toBe("none");
    expect(element?.style.transform).toBe("translate(120px, 48px)");
  });

  it("pings once per click, not per move", () => {
    const cursor = createGuestAgentCursor(document);

    cursor.show({ phase: "move", x: 10, y: 10 });
    expect(cursor.pingCount()).toBe(0);
    cursor.show({ phase: "click", x: 10, y: 10 });
    cursor.show({ phase: "move", x: 30, y: 30 });
    cursor.show({ phase: "click", x: 30, y: 30 });

    expect(cursor.pingCount()).toBe(2);
  });

  it("removes the mark once the agent goes idle so nothing keeps animating", () => {
    const cursor = createGuestAgentCursor(document);

    cursor.show({ phase: "click", x: 10, y: 10 });
    vi.advanceTimersByTime(GUEST_AGENT_CURSOR_IDLE_MS - 1);
    cursor.show({ phase: "move", x: 20, y: 20 });
    vi.advanceTimersByTime(GUEST_AGENT_CURSOR_IDLE_MS - 1);
    expect(mark()).not.toBeNull();

    vi.advanceTimersByTime(1_000);
    expect(mark()).toBeNull();
  });

  it("ignores malformed host messages", () => {
    const cursor = createGuestAgentCursor(document);

    cursor.show({ phase: "drag", x: 1, y: 1 });
    cursor.show({ phase: "move", x: Number.NaN, y: 1 });
    cursor.show(null);

    expect(mark()).toBeNull();
  });
});
