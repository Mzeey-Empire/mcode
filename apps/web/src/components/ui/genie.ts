/**
 * The Genie: a popover pours out of its trigger when it opens and back into it when it closes, like macOS
 * minimising a window to the Dock. Internal to the `Popover` wrapper; features opt in through its `motion` prop.
 */

/** How long a full pour out of the trigger takes. */
export const GENIE_OPEN_MS = 200;
/** How long a full pour back into the trigger takes. */
export const GENIE_CLOSE_MS = 160;

/** Room around the outline for the popover shadow, so the clip does not cut it while the popup moves. */
const SHADOW_SIDE = 44;
const SHADOW_UP = 28;
const SHADOW_DOWN = 60;
/** Points sampled down each side of the outline: enough for a smooth S-curve, few enough to write every frame. */
const EDGE_POINTS = 24;
/** Hides an open's popup until its first frame, when it has its place and can be measured. */
const UNMEASURED_CLIP = "inset(50%)";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smoothstep = (value: number) => value * value * (3 - 2 * value);

/** Where the popup and its trigger sit, relative to the popup's top-left corner. */
export interface GenieGeometry {
  /** Popup width. */
  readonly width: number;
  /** Popup height. */
  readonly height: number;
  /** Trigger centre, from the popup's left edge. */
  readonly originX: number;
  /** Trigger centre, from the popup's top edge. */
  readonly originY: number;
  /** Trigger width: the throat the outline pinches to. */
  readonly originWidth: number;
}

/** A point on the outline, in the popup's own pixels before its shift. */
export interface GeniePoint {
  readonly x: number;
  readonly y: number;
}

/** The popup's outline at one openness: a vertical shift, and its left and right edges from top to bottom. */
export interface GenieShape {
  readonly shift: number;
  readonly left: readonly GeniePoint[];
  readonly right: readonly GeniePoint[];
}

/**
 * The popup's outline at `openness` (0 is folded into the trigger, 1 is the open popup). Each point narrows toward the
 * trigger by an amount set by its distance from it: near points pinch to the trigger's width, far ones stay full width,
 * and the sides trace the Genie's S-curve. The funnel forms first and the popup then slides into it; opening runs the
 * path backwards. Anything that has slid past the trigger's centre line is cut off there, so the popup disappears into
 * the trigger rather than covering it.
 */
export function genieShape(openness: number, geometry: GenieGeometry): GenieShape {
  const { width, height, originX, originY, originWidth } = geometry;
  const p = 1 - clamp01(openness);
  const funnel = smoothstep(clamp01(p / 0.45));
  const shift = clamp01((p - 0.2) / 0.8) ** 2 * originY;
  const squeezeAt = (y: number) => {
    const distance = originY - (y + shift);
    return distance <= 0 ? funnel : funnel * (1 - smoothstep(clamp01(distance / originY)));
  };
  // The shadow room shrinks as its edge pinches, so a folded popup leaves no shadow outside the throat.
  const top = -SHADOW_UP * (1 - squeezeAt(0));
  const bottom = height + SHADOW_DOWN * (1 - squeezeAt(height));
  // Only content that has slid is cut at the line; the open popup's shadow may still fall across the trigger.
  const line = shift > 0 ? originY - shift : Number.POSITIVE_INFINITY;
  const left: GeniePoint[] = [];
  const right: GeniePoint[] = [];
  for (let i = 0; i < EDGE_POINTS; i++) {
    const y = Math.min(top + ((bottom - top) * i) / (EDGE_POINTS - 1), line);
    const squeeze = squeezeAt(y);
    const half = (width / 2) * (1 - squeeze * (1 - originWidth / width)) + SHADOW_SIDE * (1 - squeeze);
    const centre = width / 2 + squeeze * (originX - width / 2);
    left.push({ x: centre - half, y });
    right.push({ x: centre + half, y });
  }
  return { shift, left, right };
}

function clipPathOf(shape: GenieShape): string {
  const points = [...shape.left, ...[...shape.right].reverse()];
  return `polygon(${points.map((point) => `${point.x.toFixed(1)}px ${point.y.toFixed(1)}px`).join(",")})`;
}

/** A run of the effect from one openness to another. A reversal starts a new run from the current openness. */
export interface GenieClock {
  readonly from: number;
  readonly to: number;
  /** The full-travel duration scaled by the distance left, so a reversal mid-way takes only the time it needs. */
  readonly ms: number;
}

/** A run from `from` to `to` that takes `fullMs` for a whole pour. */
export function startClock(from: number, to: number, fullMs: number): GenieClock {
  return { from, to, ms: fullMs * Math.abs(to - from) };
}

/** Openness `elapsed` ms into a run; it settles on `to` once the run's time is up. */
export function opennessAt(clock: GenieClock, elapsed: number): number {
  const t = clock.ms > 0 ? clamp01(elapsed / clock.ms) : 1;
  return clock.from + (clock.to - clock.from) * t;
}

/** Where `popup` and `origin` sit now. Read only while the popup has no shift of the Genie's own. */
function measure(popup: HTMLElement, origin: HTMLElement): GenieGeometry | null {
  const box = popup.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const trigger = origin.getBoundingClientRect();
  return {
    width: box.width,
    height: box.height,
    originX: trigger.left + trigger.width / 2 - box.left,
    originY: trigger.top + trigger.height / 2 - box.top,
    originWidth: trigger.width,
  };
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Run {
  readonly direction: "open" | "close";
  readonly clock: GenieClock;
  /** Read on the run's first frame, because Base UI places a new popup only after it mounts. A turnaround keeps it. */
  geometry: GenieGeometry | null;
  /** The trigger the run pours from or into. An open whose popover switches to another trigger stops pouring. */
  readonly origin: HTMLElement;
  openness: number;
  frame: number;
  start: number | null;
  readonly onDone: (() => void) | undefined;
}

/**
 * Runs the Genie for one popover root. The wrapper tells it when the popup mounts, opens and closes; it owns the frame
 * loop and the real popup's inline clip and shift. Each frame writes only `clip-path` and `transform`. Every method is
 * safe to call twice.
 */
export class GenieMotion {
  private popup: HTMLElement | null = null;
  private run: Run | null = null;
  /** An open waiting for its popup, from this openness: before the first mount, or across a ref remount. */
  private pendingOpenFrom: number | null = null;

  constructor(private origin: () => HTMLElement | null) {}

  /** Points the effect at the latest trigger lookup. */
  setOrigin(origin: () => HTMLElement | null): void {
    this.origin = origin;
  }

  /** Registers the mounted popup, or `null` once it unmounts. */
  readonly setPopup = (popup: HTMLElement | null): void => {
    if (popup === this.popup) return;
    // StrictMode, or any remount, detaches the ref mid-open; the open resumes on whichever element comes back.
    if (!popup && this.run?.direction === "open") this.pendingOpenFrom = this.run.openness;
    this.stop();
    this.popup?.removeEventListener("input", this.endOpenEarly, true);
    this.popup = popup;
    popup?.addEventListener("input", this.endOpenEarly, true);
    if (popup && this.pendingOpenFrom !== null) {
      const from = this.pendingOpenFrom;
      this.pendingOpenFrom = null;
      this.startOpen(popup, from);
    }
  };

  /**
   * Pours the popup out of its trigger. The popup is laid out, focused and taking keys from the first frame, clipped
   * to its folded outline before it first paints.
   */
  open(): void {
    const popup = this.popup;
    if (!popup) {
      this.pendingOpenFrom = 0;
      return;
    }
    this.startOpen(popup, this.run ? this.run.openness : 0);
  }

  /**
   * Pours the popup back into its trigger, then calls `onDone`. Returns false, having done nothing, when the popup
   * should just fade: reduced motion or no trigger on screen.
   */
  close(onDone: () => void): boolean {
    this.pendingOpenFrom = null;
    const popup = this.popup;
    const origin = this.movingOrigin();
    if (!popup || !origin) return false;
    const geometry = this.run?.geometry ?? measure(popup, origin);
    if (!geometry) return false;
    this.start(popup, "close", startClock(this.run ? this.run.openness : 1, 0, GENIE_CLOSE_MS), origin, geometry, onDone);
    return true;
  }

  /** Abandons any run and gives the popup back its own fade, as when the overlay gate forces it closed. */
  cancel(): void {
    this.pendingOpenFrom = null;
    this.stop();
    if (!this.popup) return;
    this.popup.style.animation = "";
    delete this.popup.dataset.genie;
  }

  /** The root closed without `close()`: unless a pour back is already under way, fall back to the fade. */
  cancelUnlessClosing(): void {
    if (this.run?.direction !== "close") this.cancel();
  }

  /** Stops any run, as when the root unmounts. */
  dispose(): void {
    this.pendingOpenFrom = null;
    this.stop();
  }

  private startOpen(popup: HTMLElement, from: number): void {
    const origin = this.movingOrigin();
    if (!origin) return;
    this.start(popup, "open", startClock(from, 1, GENIE_OPEN_MS), origin, this.run?.geometry ?? null, undefined);
  }

  /** The trigger to pour from or into, or null when the popup should just fade. */
  private movingOrigin(): HTMLElement | null {
    return prefersReducedMotion() ? null : this.origin();
  }

  private start(
    popup: HTMLElement,
    direction: Run["direction"],
    clock: GenieClock,
    origin: HTMLElement,
    geometry: GenieGeometry | null,
    onDone: Run["onDone"],
  ): void {
    this.stopFrame();
    // The entry and exit fades would fight the clip, and clearing them later restarts them, so they stay off until
    // the popup unmounts or falls back to its fade. The popover's transition would ease each frame's clip and shift in
    // late, so `data-genie` turns it off too: an inline transition would not last, because Base UI sets and then
    // removes its own on mount.
    popup.style.animation = "none";
    popup.dataset.genie = "";
    popup.style.willChange = "transform";
    const run: Run = { direction, clock, geometry, origin, openness: clock.from, frame: 0, start: null, onDone };
    this.run = run;
    // Set now, from the layout effect or the ref, so the popup never paints whole before its first frame.
    if (geometry) this.draw(run, geometry);
    else popup.style.clipPath = UNMEASURED_CLIP;
    run.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    const run = this.run;
    const popup = this.popup;
    if (!run || !popup) return;
    if (run.direction === "open" && this.origin() !== run.origin) {
      this.finish();
      return;
    }
    run.geometry ??= measure(popup, run.origin);
    if (!run.geometry) {
      this.cancel();
      return;
    }
    run.start ??= now;
    run.openness = opennessAt(run.clock, now - run.start);
    this.draw(run, run.geometry);
    if (run.openness === run.clock.to) this.finish();
    else run.frame = requestAnimationFrame(this.tick);
  };

  private draw(run: Run, geometry: GenieGeometry): void {
    const popup = this.popup;
    if (!popup) return;
    const shape = genieShape(run.openness, geometry);
    popup.style.clipPath = clipPathOf(shape);
    popup.style.transform = `translateY(${shape.shift.toFixed(1)}px)`;
  }

  private readonly endOpenEarly = (): void => {
    if (this.run?.direction === "open") this.finish();
  };

  private finish(): void {
    const run = this.run;
    if (!run) return;
    // A finished close keeps its folded clip: the popup is about to unmount, and unclipping it would flash it whole.
    if (run.direction === "close") {
      this.stopFrame();
      this.run = null;
    } else {
      this.stop();
    }
    run.onDone?.();
  }

  private stop(): void {
    this.stopFrame();
    this.run = null;
    const popup = this.popup;
    if (!popup) return;
    popup.style.clipPath = "";
    popup.style.transform = "";
    popup.style.willChange = "";
  }

  private stopFrame(): void {
    if (this.run) cancelAnimationFrame(this.run.frame);
  }
}
