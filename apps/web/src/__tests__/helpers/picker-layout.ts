import { afterAll, beforeAll } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

/** Height the shim gives each listbox child: a 32px picker row plus the 1px gap. */
export const LISTBOX_ROW_PX = 33;
const LISTBOX_VIEWPORT_PX = 172;
const LAYOUT_PROPS = ["scrollHeight", "clientHeight", "offsetTop", "offsetHeight"] as const;

/**
 * jsdom does no layout. Gives every listbox in the calling test file a 172px viewport over 33px rows, each option
 * 32px tall at its place in that pitch, so the picker's scroll fades, paging and row scrolling run. Call once at
 * module level.
 */
export function installListboxLayout(): void {
  const originals = LAYOUT_PROPS.map((prop) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("role") === "listbox" ? this.childElementCount * LISTBOX_ROW_PX : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("role") === "listbox" ? LISTBOX_VIEWPORT_PX : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") !== "option" || !this.parentElement) return 0;
        return [...this.parentElement.querySelectorAll(":scope > [role=option]")].indexOf(this) * LISTBOX_ROW_PX;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute("role") === "option" ? LISTBOX_ROW_PX - 1 : 0;
      },
    });
  });
  afterAll(() => {
    LAYOUT_PROPS.forEach((prop, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(HTMLElement.prototype, prop, original);
    });
  });
}

/** Scrolls the listbox so `remainingPx` of content stays below the viewport. */
export function scrollListTo(remainingPx: number): void {
  const list = screen.getByRole("listbox");
  list.scrollTop = list.scrollHeight - list.clientHeight - remainingPx;
  fireEvent.scroll(list);
}
