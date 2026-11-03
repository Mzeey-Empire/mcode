import { useLayoutEffect, useRef } from "react";

/**
 * What a {@link SlidingHighlight} follows.
 * - A marker attribute: the row the owner already marks as highlighted (Base UI menus set
 *   `data-highlighted`, `Picker` sets `data-active`, the slash tray sets `aria-selected`). Hover and
 *   keys already move that marker, so pointer and keyboard share one fill.
 * - `pointer`: for groups with no marker of their own, the item matching the selector under a mouse
 *   or pen, then the focus-visible item once the pointer leaves or a key is pressed.
 */
export type HighlightFollow =
  | "data-highlighted"
  | "data-active"
  | "aria-selected"
  | { readonly pointer: string };

type Cause = "moved" | "rebuilt";

const MARKED_ITEM_ROLES = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

const FILL_CLASS =
  "pointer-events-none absolute top-0 left-0 bg-hover opacity-0 transition-[transform,width,height,opacity] duration-(--duration-standard) ease-(--ease-standard) data-on:opacity-100 data-snap:transition-opacity motion-reduce:transition-opacity";

/**
 * One sliding fill for a group of options. Mount it as a child of the group: the parent element is
 * the group, which must be `position: relative` and is usually the scroll container, so the fill
 * scrolls with its row. Rows must be positioned so they paint above the fill.
 *
 * It keeps no highlight state of its own and never renders again after mount: it reads the target
 * from the DOM, coalesced to one read and one write per frame. A move slides; a rebuilt list snaps
 * in place; no target fades out where it is; a group with one option shows no fill. It never
 * scrolls, so hovering a cut-off row leaves the list still.
 */
export function SlidingHighlight({ follow }: { readonly follow: HighlightFollow }) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const marker = typeof follow === "string" ? follow : null;
  const pointer = typeof follow === "string" ? null : follow.pointer;
  useLayoutEffect(() => {
    const fill = fillRef.current;
    const group = fill?.parentElement;
    if (!fill || !group) return;
    return marker
      ? followMarker(group, fill, marker)
      : followPointer(group, fill, pointer ?? "");
  }, [marker, pointer]);
  return <span ref={fillRef} aria-hidden="true" data-slot="sliding-highlight" className={FILL_CLASS} />;
}

/**
 * Coalesces changes to one placement per frame; a rebuild in the frame wins over a move so it snaps. While the group's
 * popup pours (`data-pouring`), its rows are squeezed and their rects are not where they rest, so placement waits.
 */
function frameScheduler(group: HTMLElement, place: (cause: Cause) => void) {
  let frame = 0;
  let pending: Cause | null = null;
  const run = () => {
    if (group.closest("[data-pouring]")) {
      frame = requestAnimationFrame(run);
      return;
    }
    frame = 0;
    const next = pending ?? "moved";
    pending = null;
    place(next);
  };
  const schedule = (cause: Cause) => {
    pending = pending === "rebuilt" ? "rebuilt" : cause;
    if (frame) return;
    frame = requestAnimationFrame(run);
  };
  const cancel = () => {
    if (frame) cancelAnimationFrame(frame);
  };
  return { schedule, cancel };
}

function followMarker(group: HTMLElement, fill: HTMLElement, marker: string): () => void {
  const markedSelector = `[${marker}]:not([${marker}="false"])`;
  let pointerInside = false;
  const { schedule, cancel } = frameScheduler(group, (cause) => {
    if (countItems(group, MARKED_ITEM_ROLES) <= 1) return place(fill, group, null, cause);
    const marked = group.querySelector(markedSelector);
    // A menu unmarks its rows while the pointer crosses a rule or gap; the fill waits there and slides to the next row.
    if (!marked && pointerInside) return;
    place(fill, group, marked, cause);
  });
  const observer = new MutationObserver((records) => {
    schedule(records.some((record) => record.type === "childList") ? "rebuilt" : "moved");
  });
  const onOver = (event: PointerEvent) => {
    if (event.pointerType !== "touch") pointerInside = true;
  };
  const onOut = (event: PointerEvent) => {
    if (event.relatedTarget instanceof Node && group.contains(event.relatedTarget)) return;
    pointerInside = false;
    schedule("moved");
  };
  observer.observe(group, { subtree: true, childList: true, attributes: true, attributeFilter: [marker] });
  group.addEventListener("pointerover", onOver);
  group.addEventListener("pointerout", onOut);
  schedule("rebuilt");
  return () => {
    observer.disconnect();
    group.removeEventListener("pointerover", onOver);
    group.removeEventListener("pointerout", onOut);
    cancel();
  };
}

function followPointer(group: HTMLElement, fill: HTMLElement, selector: string): () => void {
  let hovered: Element | null = null;
  const target = () => {
    if (countItems(group, selector) <= 1) return null;
    return hovered ?? group.querySelector(`${selector}:focus-visible`);
  };
  const { schedule, cancel } = frameScheduler(group, (cause) => place(fill, group, target(), cause));
  const onPointer = (event: PointerEvent) => {
    if (event.pointerType === "touch" || !(event.target instanceof Element)) return;
    const item = event.target.closest(selector);
    // Gaps between items keep the fill where it is, so crossing a gap does not flicker it off.
    if (!item || item === hovered || !group.contains(item)) return;
    hovered = item;
    schedule("moved");
  };
  // A key hands the fill to the focused item until the pointer moves again, even if it rests on another item.
  const onKey = () => {
    if (!hovered) return;
    hovered = null;
    schedule("moved");
  };
  const onOut = (event: PointerEvent) => {
    if (event.relatedTarget instanceof Node && group.contains(event.relatedTarget)) return;
    hovered = null;
    schedule("moved");
  };
  const onFocusChange = () => schedule("moved");
  group.addEventListener("pointerover", onPointer);
  group.addEventListener("pointermove", onPointer);
  group.addEventListener("pointerout", onOut);
  group.addEventListener("keydown", onKey);
  group.addEventListener("focusin", onFocusChange);
  group.addEventListener("focusout", onFocusChange);
  return () => {
    group.removeEventListener("pointerover", onPointer);
    group.removeEventListener("pointermove", onPointer);
    group.removeEventListener("pointerout", onOut);
    group.removeEventListener("keydown", onKey);
    group.removeEventListener("focusin", onFocusChange);
    group.removeEventListener("focusout", onFocusChange);
    cancel();
  };
}

function countItems(group: HTMLElement, selector: string): number {
  return group.querySelectorAll(selector).length;
}

/**
 * Puts the fill on `item` in the group's content coordinates, or fades it out for `null`. Client
 * rects rather than offsets, because offsets round to whole pixels and the fill would sit a
 * fraction off its row; the scroll offset keeps it in the content so it scrolls with the row.
 */
function place(fill: HTMLElement, group: HTMLElement, item: Element | null, cause: Cause): void {
  if (!item) {
    delete fill.dataset.on;
    return;
  }
  // Every read comes before the first write, so placing the fill costs one layout, not one per read.
  const box = item.getBoundingClientRect();
  const origin = group.getBoundingClientRect();
  const x = box.left - origin.left - group.clientLeft + group.scrollLeft;
  const y = box.top - origin.top - group.clientTop + group.scrollTop;
  const radius = getComputedStyle(item).borderRadius;
  // A hidden fill fades in where it lands instead of sliding from a stale spot.
  if (cause === "rebuilt" || fill.dataset.on === undefined) fill.dataset.snap = "";
  else delete fill.dataset.snap;
  fill.style.transform = `translate(${x}px,${y}px)`;
  fill.style.width = `${box.width}px`;
  fill.style.height = `${box.height}px`;
  fill.style.borderRadius = radius;
  fill.dataset.on = "";
}
