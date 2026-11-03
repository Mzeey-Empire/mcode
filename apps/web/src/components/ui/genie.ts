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
const SHADOW_GONE = 0.1;
/** Points sampled down each side of the outline: enough for a smooth S-curve, few enough to write every frame. */
const EDGE_POINTS = 24;
/** Hides an open's popup until its first frame, when it has its place and can be measured. */
const UNMEASURED_CLIP = "inset(50%)";
const THROAT = 24;
const BAND_MAX_HEIGHT = 48;

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

/** A row of the popup that squeezes as one piece, in the popup's own pixels before its shift. */
export interface GenieBand {
  /** The band's vertical middle. */
  readonly mid: number;
  /** The point the band scales about: its transform origin. */
  readonly pivotX: number;
  readonly pivotY: number;
}

/** A band's CSS `translate` and `scale` at one openness. */
export interface GenieSqueeze {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

function pourAt(openness: number, geometry: GenieGeometry) {
  const { originY } = geometry;
  const p = 1 - clamp01(openness);
  const funnel = smoothstep(clamp01(p / 0.45));
  const shift = clamp01((p - 0.2) / 0.8) ** 2 * originY;
  const squeezeAt = (y: number) => {
    const distance = originY - (y + shift);
    return distance <= 0 ? funnel : funnel * (1 - smoothstep(clamp01(distance / originY)));
  };
  return { shift, squeezeAt };
}

function funnelRow(squeeze: number, geometry: GenieGeometry) {
  const { width, originX, originWidth } = geometry;
  return { centre: width / 2 + squeeze * (originX - width / 2), scale: 1 - squeeze * (1 - originWidth / width) };
}

/**
 * The popup's outline at `openness` (0 is folded into the trigger, 1 is the open popup). Each point narrows toward the
 * trigger by an amount set by its distance from it: near points pinch to the trigger's width, far ones stay full width,
 * and the sides trace the Genie's S-curve. The funnel forms first and the popup then slides into it; opening runs the
 * path backwards. Anything that has slid past the trigger's centre line is cut off there, so the popup disappears into
 * the trigger rather than covering it.
 */
export function genieShape(openness: number, geometry: GenieGeometry): GenieShape {
  const { width, height, originY } = geometry;
  const { shift, squeezeAt } = pourAt(openness, geometry);
  const shadowRoom = (squeeze: number) => 1 - clamp01(squeeze / SHADOW_GONE);
  const top = -SHADOW_UP * shadowRoom(squeezeAt(0));
  const bottom = height + SHADOW_DOWN * shadowRoom(squeezeAt(height));
  // Only content that has slid is cut at the line; the open popup's shadow may still fall across the trigger.
  const line = shift > 0 ? originY - shift : Number.POSITIVE_INFINITY;
  const left: GeniePoint[] = [];
  const right: GeniePoint[] = [];
  for (let i = 0; i < EDGE_POINTS; i++) {
    const y = Math.min(top + ((bottom - top) * i) / (EDGE_POINTS - 1), line);
    const squeeze = squeezeAt(y);
    const row = funnelRow(squeeze, geometry);
    const half = (width / 2) * row.scale + SHADOW_SIDE * shadowRoom(squeeze);
    left.push({ x: row.centre - half, y });
    right.push({ x: row.centre + half, y });
  }
  return { shift, left, right };
}

/**
 * How `band` moves at `openness`: the popup's full width at the band's middle lands on the outline's row there, so
 * the content narrows and drifts with the funnel, and the band flattens as it nears the trigger's centre line. A band
 * that has slid past that line is flat; the outline cuts there anyway.
 */
export function genieBandSqueeze(openness: number, geometry: GenieGeometry, band: GenieBand): GenieSqueeze {
  const { shift, squeezeAt } = pourAt(openness, geometry);
  const row = funnelRow(squeezeAt(band.mid), geometry);
  const scaleY = clamp01((geometry.originY - (band.mid + shift)) / THROAT);
  return {
    x: row.centre - (geometry.width / 2) * row.scale - band.pivotX * (1 - row.scale),
    y: (band.mid - band.pivotY) * (1 - scaleY),
    scaleX: row.scale,
    scaleY,
  };
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

interface MeasuredBand {
  readonly element: HTMLElement | SVGElement;
  readonly band: GenieBand;
}

interface Measured {
  readonly geometry: GenieGeometry;
  readonly bands: readonly MeasuredBand[];
}

function measure(popup: HTMLElement, origin: HTMLElement): Measured | null {
  const box = popup.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const trigger = origin.getBoundingClientRect();
  const geometry = {
    width: box.width,
    height: box.height,
    originX: trigger.left + trigger.width / 2 - box.left,
    originY: trigger.top + trigger.height / 2 - box.top,
    originWidth: trigger.width,
  };
  return { geometry, bands: measureBands(popup, box) };
}

function measureBands(popup: HTMLElement, box: DOMRect): MeasuredBand[] {
  const bands: MeasuredBand[] = [];
  const visit = (element: Element) => {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const tall = rect.height > BAND_MAX_HEIGHT && element.children.length > 0;
    if (style.display === "contents" || tall) return [...element.children].forEach(visit);
    const pivot = showsIn(rect, box) ? pivotOf(style, rect) : null;
    if (!pivot) return;
    bands.push({ element, band: { mid: rect.top - box.top + rect.height / 2, pivotX: pivot.x - box.left, pivotY: pivot.y - box.top } });
  };
  [...popup.children].forEach(visit);
  return bands;
}

function showsIn(rect: DOMRect, box: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom;
}

function pivotOf(style: CSSStyleDeclaration, rect: DOMRect): GeniePoint | null {
  const moved = translationOf(style);
  if (!moved) return null;
  const [x = Number.NaN, y = Number.NaN] = style.transformOrigin.split(" ").map(parseFloat);
  return {
    x: rect.left - moved.x + (Number.isFinite(x) ? x : rect.width / 2),
    y: rect.top - moved.y + (Number.isFinite(y) ? y : rect.height / 2),
  };
}

function translationOf(style: CSSStyleDeclaration): GeniePoint | null {
  const own = [style.translate, style.scale, style.rotate].some((value) => value && value !== "none");
  if (own) return null;
  if (!style.transform || style.transform === "none") return { x: 0, y: 0 };
  const match = /^matrix\(1, 0, 0, 1, ([^,]+), ([^)]+)\)$/.exec(style.transform);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Run {
  readonly direction: "open" | "close";
  readonly clock: GenieClock;
  /** Read on the run's first frame, because Base UI places a new popup only after it mounts. A turnaround keeps it. */
  measured: Measured | null;
  /** The trigger the run pours from or into. An open whose popover switches to another trigger stops pouring. */
  readonly origin: HTMLElement;
  openness: number;
  frame: number;
  start: number | null;
  readonly onDone: (() => void) | undefined;
}

/**
 * Runs the Genie for one popover root. The wrapper tells it when the popup mounts, opens and closes; it owns the frame
 * loop, the real popup's inline clip and shift, and its rows' inline `translate` and `scale`. While a run is under way
 * the popup carries `data-pouring`, so anything that measures the rows can wait for them to rest. Every method is safe
 * to call twice.
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
    const measured = this.run?.measured ?? measure(popup, origin);
    if (!measured) return false;
    this.start(popup, "close", startClock(this.run ? this.run.openness : 1, 0, GENIE_CLOSE_MS), origin, measured, onDone);
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
    this.start(popup, "open", startClock(from, 1, GENIE_OPEN_MS), origin, this.run?.measured ?? null, undefined);
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
    measured: Measured | null,
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
    popup.dataset.pouring = "";
    const run: Run = { direction, clock, measured, origin, openness: clock.from, frame: 0, start: null, onDone };
    this.run = run;
    // Set now, from the layout effect or the ref, so the popup never paints whole before its first frame.
    if (measured) this.draw(run, measured);
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
    run.measured ??= measure(popup, run.origin);
    if (!run.measured) {
      this.cancel();
      return;
    }
    run.start ??= now;
    run.openness = opennessAt(run.clock, now - run.start);
    this.draw(run, run.measured);
    if (run.openness === run.clock.to) this.finish();
    else run.frame = requestAnimationFrame(this.tick);
  };

  private draw(run: Run, { geometry, bands }: Measured): void {
    const popup = this.popup;
    if (!popup) return;
    const shape = genieShape(run.openness, geometry);
    popup.style.clipPath = clipPathOf(shape);
    popup.style.transform = `translateY(${shape.shift.toFixed(1)}px)`;
    for (const { element, band } of bands) {
      const squeeze = genieBandSqueeze(run.openness, geometry, band);
      element.style.translate = `${squeeze.x.toFixed(2)}px ${squeeze.y.toFixed(2)}px`;
      element.style.scale = `${squeeze.scaleX.toFixed(4)} ${squeeze.scaleY.toFixed(4)}`;
    }
  }

  private readonly endOpenEarly = (): void => {
    if (this.run?.direction === "open") this.finish();
  };

  private finish(): void {
    const run = this.run;
    if (!run) return;
    if (run.direction === "close") {
      this.stopFrame();
      this.run = null;
      if (this.popup) delete this.popup.dataset.pouring;
    } else {
      this.stop();
    }
    run.onDone?.();
  }

  private stop(): void {
    this.stopFrame();
    for (const { element } of this.run?.measured?.bands ?? []) {
      element.style.translate = "";
      element.style.scale = "";
    }
    this.run = null;
    const popup = this.popup;
    if (!popup) return;
    popup.style.clipPath = "";
    popup.style.transform = "";
    popup.style.willChange = "";
    delete popup.dataset.pouring;
  }

  private stopFrame(): void {
    if (this.run) cancelAnimationFrame(this.run.frame);
  }
}
