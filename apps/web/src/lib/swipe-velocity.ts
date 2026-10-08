/** One pointer position along the swipe axis. */
export interface SwipeSample {
  readonly x: number;
  readonly time: number;
}

/** Release speed is measured over roughly this much recent movement. */
const VELOCITY_WINDOW_MS = 80;

/**
 * Release speed over the last moments of a swipe. Measuring from the press
 * would let a press-and-hold dilute a fast flick at the end.
 */
export class SwipeVelocity {
  private anchor: SwipeSample | null = null;
  private latest: SwipeSample | null = null;

  /** Starts a new gesture at `sample`. */
  reset(sample: SwipeSample) {
    this.anchor = sample;
    this.latest = sample;
  }

  /** Records a move. The anchor trails the newest sample by one window. */
  track(sample: SwipeSample) {
    if (this.latest && this.anchor && sample.time - this.anchor.time > VELOCITY_WINDOW_MS) this.anchor = this.latest;
    this.latest = sample;
  }

  /** Absolute speed in px/ms from the trailing anchor to the release `sample`. */
  pxPerMs(sample: SwipeSample) {
    if (!this.anchor) return 0;
    return Math.abs(sample.x - this.anchor.x) / Math.max(1, sample.time - this.anchor.time);
  }
}
