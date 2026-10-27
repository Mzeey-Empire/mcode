/** Where a flying copy lands. */
export type FlightTarget = "completed-segment" | "older-bar";

/** When and how a copy flies. */
export interface FlightTiming {
  readonly delayMs: number;
  readonly durationMs: number;
  readonly easing: string;
}

function sourceLine(threadId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid='thread-item'][data-thread-id='${CSS.escape(threadId)}'] [data-title-line]`);
}

function targetElement(to: FlightTarget): Element | null {
  if (to === "older-bar") return document.querySelector("[data-testid='older-bar'] button");
  const segments = document.querySelectorAll("[data-testid='sidebar-scope-bar'] [role='radio']");
  return segments.item(segments.length - 1);
}

function copyOf(line: HTMLElement, rect: DOMRect): HTMLElement {
  const copy = line.cloneNode(true);
  if (!(copy instanceof HTMLElement)) throw new Error("A title line clones to an element");
  copy.removeAttribute("data-title-line");
  copy.setAttribute("aria-hidden", "true");
  Object.assign(copy.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "var(--layer-toast)",
  });
  copy.classList.add("rounded-md", "bg-selected", "shadow-floating");
  return copy;
}

/**
 * Flies a copy of a thread row's title line to the Completed segment or the Older bar, outside
 * the virtual list so recycling cannot touch it. Resolves when the copy lands, or at once when
 * either end is not on screen.
 */
export function flyCopy(threadId: string, to: FlightTarget, timing: FlightTiming): Promise<void> {
  const line = sourceLine(threadId);
  const target = targetElement(to);
  if (!line || !target || typeof line.animate !== "function") return Promise.resolve();
  const from = line.getBoundingClientRect();
  const end = target.getBoundingClientRect();
  const copy = copyOf(line, from);
  document.body.append(copy);
  const dx = end.left + end.width / 2 - (from.left + from.width / 2);
  const dy = end.top + end.height / 2 - (from.top + from.height / 2);
  // The copy lifts first and then curves across, so x lags y at the midpoint.
  const flight = copy.animate(
    [
      { transform: "none", opacity: 1 },
      { transform: `translate(${dx * 0.25}px, ${dy * 0.6}px) scale(0.8)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 },
    ],
    { duration: timing.durationMs, delay: timing.delayMs, easing: timing.easing, fill: "backwards" },
  );
  return flight.finished.then(
    () => copy.remove(),
    () => copy.remove(),
  );
}
