import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_LIFETIME_MS, useToastStore, type ToastInput } from "@/stores/toastStore";
import { ToastLane } from "../toast";

const store = () => useToastStore.getState();
const show = (input: ToastInput) => act(() => void store().show(input));
const lane = () => screen.getByRole("region", { name: "Notifications" });
const toastTitles = () =>
  [...lane().querySelectorAll('[role="status"], [role="alert"]')].map((toast) => toast.textContent);

function renderLane() {
  return render(
    <>
      <input aria-label="Composer" />
      <ToastLane anchor={null} fallbackRef={{ current: null }} reserveOverview={false} />
    </>,
  );
}

/** Lets exiting toasts finish their exit animation. */
const finishExits = () => act(() => void vi.advanceTimersByTime(300));

beforeEach(() => {
  vi.useFakeTimers();
  for (const toast of store().toasts) store().dismiss(toast.id);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ToastLane", () => {
  it("shows three toasts, newest on top, and lets the dropped one exit", () => {
    renderLane();
    for (const title of ["one", "two", "three", "four"]) show({ kind: "failed", title });
    // The dropped toast stays on screen for its exit animation.
    expect(toastTitles()).toEqual(["four", "three", "two", "one"]);
    finishExits();

    expect(toastTitles()).toEqual(["four", "three", "two"]);
  });

  it("announces finished and info toasts politely and needs-you and failed assertively", () => {
    renderLane();
    show({ kind: "finished", title: "a" });
    show({ kind: "info", title: "b" });
    show({ kind: "needs-you", title: "c" });

    expect(within(lane()).getAllByRole("status")).toHaveLength(2);
    expect(within(lane()).getAllByRole("alert")).toHaveLength(1);
  });

  it("does not take focus when a toast appears", () => {
    renderLane();
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    show({ kind: "needs-you", title: "Approve the plan", onOpen: vi.fn() });

    expect(composer).toHaveFocus();
  });

  it("opens the object on Enter and dismisses the toast", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderLane();
    show({ kind: "needs-you", title: "Approve the plan", meta: "Approval required · 14:35", onOpen });

    screen.getByRole("button", { name: /Approve the plan/ }).focus();
    await user.keyboard("{Enter}");

    expect(onOpen).toHaveBeenCalledOnce();
    expect(store().toasts).toEqual([]);
  });

  it("closes a focused toast on Escape", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });

    screen.getByRole("button", { name: "Dismiss" }).focus();
    await user.keyboard("{Escape}");

    expect(store().toasts).toEqual([]);
  });

  it("keeps a toast whose open handler throws", () => {
    const failure = new Error("thread was deleted");
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallow);
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderLane();
    show({ kind: "needs-you", title: "Approve the plan", onOpen: () => { throw failure; } });

    try {
      fireEvent.click(screen.getByRole("button", { name: /Approve the plan/ }));
    } catch (error) {
      expect(error).toBe(failure);
    } finally {
      window.removeEventListener("error", swallow);
    }

    expect(store().toasts).toHaveLength(1);
  });

  it("keeps a finished toast while the pointer rests on it", () => {
    renderLane();
    show({ kind: "finished", title: "Refine navigation" });

    fireEvent.pointerEnter(within(lane()).getByRole("status"));
    act(() => void vi.advanceTimersByTime(TOAST_LIFETIME_MS * 2));
    expect(store().toasts).toHaveLength(1);

    fireEvent.pointerLeave(within(lane()).getByRole("status"));
    act(() => void vi.advanceTimersByTime(TOAST_LIFETIME_MS));
    expect(store().toasts).toEqual([]);
  });

  it("colours the meta label before the first separator", () => {
    renderLane();
    show({ kind: "finished", title: "Refine navigation", meta: "Finished · 14:32" });

    expect(within(lane()).getByText("Finished")).toHaveClass("text-success");
  });

  it("dismisses on a sideways trackpad swipe past a third of the card", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(340);
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });
    const card = within(lane()).getByRole("alert");

    for (let step = 0; step < 4; step++) fireEvent.wheel(card, { deltaX: -40, deltaY: 2 });
    // The quiet gap ends the gesture, then the card flies out.
    act(() => void vi.advanceTimersByTime(200));
    act(() => void vi.advanceTimersByTime(200));

    expect(store().toasts).toEqual([]);
  });

  it("springs back from a short trackpad swipe and ignores vertical scroll", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(340);
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });
    const card = within(lane()).getByRole("alert");

    fireEvent.wheel(card, { deltaX: -60, deltaY: 0 });
    fireEvent.wheel(card, { deltaX: 0, deltaY: 400 });
    act(() => void vi.advanceTimersByTime(300));

    expect(store().toasts).toHaveLength(1);
  });

  it("dismisses on a short, fast trackpad flick", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(340);
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });
    const card = within(lane()).getByRole("alert");

    // 80px is under the 119px distance threshold; 40px per 16ms is a flick.
    for (let step = 0; step < 2; step++) {
      fireEvent.wheel(card, { deltaX: -40, deltaY: 0 });
      act(() => void vi.advanceTimersByTime(16));
    }
    act(() => void vi.advanceTimersByTime(200));
    act(() => void vi.advanceTimersByTime(200));

    expect(store().toasts).toEqual([]);
  });

  it("lets a pointer swipe win over a trackpad gesture still settling", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(340);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });
    const card = within(lane()).getByRole("alert");

    fireEvent.wheel(card, { deltaX: -10, deltaY: 0 });
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(card, { pointerId: 1, buttons: 1, clientX: 150 });
    // Released before the wheel gesture's quiet gap ends.
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 150 });
    // Separate steps let React render between the wheel end (120ms) and the fly-out (160ms), as a browser would.
    act(() => void vi.advanceTimersByTime(130));
    act(() => void vi.advanceTimersByTime(300));

    expect(store().toasts).toEqual([]);
  });

  it("does not read a slow sideways trackpad scroll as a flick", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(340);
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });
    const card = within(lane()).getByRole("alert");

    // 5px per 16ms is 0.31px/ms, under the flick speed.
    for (let step = 0; step < 2; step++) {
      fireEvent.wheel(card, { deltaX: -5, deltaY: 0 });
      act(() => void vi.advanceTimersByTime(16));
    }
    act(() => void vi.advanceTimersByTime(200));
    act(() => void vi.advanceTimersByTime(200));

    expect(store().toasts).toHaveLength(1);
  });

  it("keeps a toast when a fast trackpad swipe reverses back to rest", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(340);
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });
    const card = within(lane()).getByRole("alert");

    for (const [deltaX, gap] of [[-40, 16], [-40, 32], [40, 32], [40, 0]] as const) {
      fireEvent.wheel(card, { deltaX, deltaY: 0 });
      act(() => void vi.advanceTimersByTime(gap));
    }
    act(() => void vi.advanceTimersByTime(200));
    act(() => void vi.advanceTimersByTime(200));

    expect(store().toasts).toHaveLength(1);
  });

  it("still takes trackpad swipes after a press released outside the card", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(340);
    renderLane();
    show({ kind: "failed", title: "Bump Electron" });
    const card = within(lane()).getByRole("alert");

    // The press never becomes a drag, so its release outside the card is never seen.
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 0 });
    for (let step = 0; step < 4; step++) fireEvent.wheel(card, { deltaX: -40, deltaY: 0 });
    act(() => void vi.advanceTimersByTime(200));
    act(() => void vi.advanceTimersByTime(200));

    expect(store().toasts).toEqual([]);
  });
});
