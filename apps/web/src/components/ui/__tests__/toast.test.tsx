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
});
