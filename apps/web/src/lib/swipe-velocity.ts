/** One position along the swipe axis. */
export interface SwipeSample {
  readonly x: number;
  readonly time: number;
}

/** Speed is measured over at most this much recent movement. */
const VELOCITY_WINDOW_MS = 80;

/**
 * Swipe speed over the last moments of a gesture. Measuring from the press
 * would let a press-and-hold dilute a fast flick at the end.
 */
export class SwipeVelocity {
  private samples: SwipeSample[] = [];

  /** Starts a new gesture at `sample`. */
  reset(sample: SwipeSample) {
    this.samples = [sample];
  }

  /** Records a move, keeping one sample older than the window as the baseline. */
  track(sample: SwipeSample) {
    this.samples.push(sample);
    const windowStart = sample.time - VELOCITY_WINDOW_MS;
    while (this.samples.length > 2 && (this.samples[1]?.time ?? windowStart + 1) <= windowStart) this.samples.shift();
  }

  /**
   * Absolute speed in px/ms ending at `sample`, from the oldest sample inside
   * the window, or from the sample just before the window when none is inside.
   */
  pxPerMs(sample: SwipeSample) {
    const windowStart = sample.time - VELOCITY_WINDOW_MS;
    const prior = this.samples.filter((entry) => entry.time < sample.time);
    const baseline = prior.find((entry) => entry.time >= windowStart) ?? prior.at(-1);
    if (!baseline) return 0;
    return Math.abs(sample.x - baseline.x) / Math.max(1, sample.time - baseline.time);
  }
}
