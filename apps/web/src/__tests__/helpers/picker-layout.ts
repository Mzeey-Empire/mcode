import { afterAll, beforeAll } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

/** Height the shim gives each listbox child: a 32px picker row plus the 1px gap. */
export const LISTBOX_ROW_PX = 33;
const LISTBOX_VIEWPORT_PX = 172;
const LAYOUT_PROPS = ["scrollHeight", "clientHeight"] as const;

/**
 * jsdom does no layout. Gives every listbox in the calling test file a 172px viewport over 33px rows, so the
 * picker's scroll fades and paging run. Call once at module level.
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
