import { useLayoutEffect, useRef, type RefObject } from "react";

/** Easing shared by every 04g track. */
const EASING = "cubic-bezier(.2, 0, 0, 1)";

/** A record older than this belongs to a send whose surface never mounted in time, so it is ignored. */
export const FIRST_SEND_RECORD_TTL_MS = 1000;

// Both composers render the same card, so measuring it rather than the composer root skips the new-thread rail above it.
const COMPOSER_CARD_SELECTOR = '[data-testid="composer-surface"]';

/** One WAAPI animation: keyframes plus timing. */
export interface TrackAnimation {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
}

/** The 04g tracks the thread surface plays; a missing track does not animate. */
export interface FirstSendAnimations {
  readonly startColumn?: TrackAnimation;
  readonly composer?: TrackAnimation;
  readonly message?: TrackAnimation;
  readonly steps?: TrackAnimation;
}

/** What the new-thread start column looked like when Send was pressed. */
export interface FirstSendRecord {
  readonly recordedAt: number;
  readonly composerTop: number;
  /** A copy of the start column with its composer card hidden, drawn where the column was. */
  readonly startColumn: { readonly clone: HTMLElement; readonly rect: DOMRectReadOnly } | undefined;
}

const records = new Map<string, FirstSendRecord>();

/**
 * Records the start column's composer position and a copy of its heading and hint.
 *
 * Call after the send is dispatched, while the start column is still in the DOM. The record is keyed by the
 * placeholder thread id the docked surface mounts with.
 */
export function recordFirstSend(threadId: string, startColumn: HTMLElement, now = performance.now()): void {
  const card = startColumn.querySelector(COMPOSER_CARD_SELECTOR);
  if (!card) return;
  forgetExpired(now);
  const clone = startColumn.cloneNode(true) as HTMLElement;
  const clonedCard = clone.querySelector<HTMLElement>(COMPOSER_CARD_SELECTOR);
  if (clonedCard) clonedCard.style.visibility = "hidden";
  // The copy is on screen next to the live surface for 120ms, so it must not answer id or test-id lookups.
  for (const element of [clone, ...clone.querySelectorAll("[id], [data-testid]")]) {
    element.removeAttribute("id");
    element.removeAttribute("data-testid");
  }
  // Re-inserting the copy would restart the heading's entrance animation under the fade-out.
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement | SVGElement>("*")]) {
    element.style.animation = "none";
  }
  records.set(threadId, {
    recordedAt: now,
    composerTop: card.getBoundingClientRect().top,
    startColumn: { clone, rect: startColumn.getBoundingClientRect() },
  });
}

// A send whose surface never mounted leaves its record behind; dropping it releases the cloned column.
function forgetExpired(now: number): void {
  for (const [threadId, record] of records) {
    if (now - record.recordedAt > FIRST_SEND_RECORD_TTL_MS) records.delete(threadId);
  }
}

/** Returns and forgets the thread's first-send record, or undefined when there is none or it expired. */
export function takeFirstSend(threadId: string, now = performance.now()): FirstSendRecord | undefined {
  const record = records.get(threadId);
  records.delete(threadId);
  if (!record || now - record.recordedAt > FIRST_SEND_RECORD_TTL_MS) return undefined;
  return record;
}

const RISE: Keyframe[] = [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }];
const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];

/** The 04g timeline for a composer that moved `dy` pixels to its dock. Reduced motion only fades. */
export function firstSendAnimations(dy: number, reducedMotion: boolean): FirstSendAnimations {
  if (reducedMotion) {
    const fade = { keyframes: FADE_IN, options: { duration: 120, easing: EASING, fill: "backwards" } } as const;
    return { message: fade, steps: fade };
  }
  return {
    startColumn: { keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 120, easing: EASING, fill: "forwards" } },
    composer: {
      keyframes: [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
      options: { duration: 240, easing: EASING },
    },
    message: { keyframes: RISE, options: { duration: 180, delay: 120, easing: EASING, fill: "backwards" } },
    steps: { keyframes: RISE, options: { duration: 180, delay: 240, easing: EASING, fill: "backwards" } },
  };
}

/** Sidebar motion: the new row fades in; a row that moved `offset` pixels slides from where it was. */
export interface SidebarRowAnimations {
  readonly entering: TrackAnimation;
  readonly shifted: (offset: number) => TrackAnimation;
}

/** Sidebar timing for a first send. Reduced motion keeps the sidebar still. */
export function sidebarRowAnimations(reducedMotion: boolean): SidebarRowAnimations | undefined {
  if (reducedMotion) return undefined;
  const options = { duration: 180, easing: EASING } as const;
  return {
    entering: { keyframes: FADE_IN, options },
    shifted: (offset) => ({ keyframes: [{ transform: `translateY(${-offset}px)` }, { transform: "translateY(0)" }], options }),
  };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function play(element: Element | null | undefined, track: TrackAnimation | undefined): Animation | undefined {
  // jsdom has no WAAPI; every shipped renderer does.
  if (!element || !track || typeof element.animate !== "function") return undefined;
  return element.animate(track.keyframes, track.options);
}

function fadeOutStartColumn(startColumn: NonNullable<FirstSendRecord["startColumn"]>, track: TrackAnimation | undefined): void {
  if (!track) return;
  const { clone, rect } = startColumn;
  clone.setAttribute("aria-hidden", "true");
  clone.inert = true;
  Object.assign(clone.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
  });
  document.body.append(clone);
  const animation = play(clone, track);
  const remove = () => clone.remove();
  if (!animation) remove();
  // A cancelled animation rejects `finished`; the copy goes either way.
  else void animation.finished.then(remove, remove);
}

/** Element refs the docked thread surface attaches for the first-send motion. */
export interface FirstSendMotionRefs {
  readonly composer: RefObject<HTMLDivElement | null>;
  readonly message: RefObject<HTMLDivElement | null>;
  readonly steps: RefObject<HTMLDivElement | null>;
}

/**
 * Plays the 04g first-send motion once when a docked thread surface mounts for a thread that was just sent
 * from the start column. Runs before paint, so the composer never shows at its dock first.
 */
export function useFirstSendMotion(threadId: string): FirstSendMotionRefs {
  const composer = useRef<HTMLDivElement>(null);
  const message = useRef<HTMLDivElement>(null);
  const steps = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const record = takeFirstSend(threadId);
    const card = composer.current?.querySelector(COMPOSER_CARD_SELECTOR);
    if (!record || !card) return;
    const animations = firstSendAnimations(record.composerTop - card.getBoundingClientRect().top, prefersReducedMotion());
    if (record.startColumn) fadeOutStartColumn(record.startColumn, animations.startColumn);
    play(composer.current, animations.composer);
    play(message.current, animations.message);
    play(steps.current, animations.steps);
  }, [threadId]);
  return { composer, message, steps };
}

/**
 * Fades in a sidebar row for a thread that was just sent and slides the rows that moved into place.
 *
 * `rowKeys` is the section's row order: thread ids, and `draft:<id>` for drafts, so a draft that turns into
 * the new thread nets out to no movement. `list` holds one child per row, carrying `data-thread-id` or
 * `data-draft-id`. Only a preparing thread whose row did not exist before animates, so a retried
 * placeholder or a project opened with a thread already preparing stays still.
 */
export function usePreparingRowEntrance(
  list: RefObject<HTMLElement | null>,
  rowKeys: readonly string[],
  preparingThreadIds: readonly string[],
): void {
  const previous = useRef<readonly string[] | undefined>(undefined);
  const rowKey = rowKeys.join("\n");
  const preparingKey = preparingThreadIds.join("\n");
  useLayoutEffect(() => {
    const rows = splitKey(rowKey);
    const before = previous.current;
    previous.current = rows;
    const container = list.current;
    if (!before || !container) return;
    const entering = splitKey(preparingKey).find((id) => !before.includes(id));
    if (!entering) return;
    const elements = new Map<string, HTMLElement>();
    for (const child of container.children) {
      if (!(child instanceof HTMLElement)) continue;
      const { threadId, draftId } = child.dataset;
      if (threadId) elements.set(threadId, child);
      else if (draftId) elements.set(`draft:${draftId}`, child);
    }
    const enteringRow = elements.get(entering);
    const animations = sidebarRowAnimations(prefersReducedMotion());
    if (!enteringRow || !animations) return;
    const rowHeight = enteringRow.getBoundingClientRect().height;
    play(enteringRow, animations.entering);
    const indexBefore = new Map(before.map((key, index) => [key, index]));
    rows.forEach((key, index) => {
      const was = indexBefore.get(key);
      if (was !== undefined && was !== index) play(elements.get(key), animations.shifted((index - was) * rowHeight));
    });
  }, [rowKey, preparingKey, list]);
}

function splitKey(key: string): string[] {
  return key === "" ? [] : key.split("\n");
}
