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
  private direction = 0;

  /** Starts a new gesture at `sample`. */
  reset(sample: SwipeSample) {
    this.samples = [sample];
    this.direction = 0;
  }

  /**
   * Records a move, keeping one sample older than the window as the baseline.
   * A reversal restarts measurement from the turning point, so speed toward
   * rest never borrows the outward movement before it. Returns whether it reversed.
   */
  track(sample: SwipeSample): boolean {
    const latest = this.samples.at(-1);
    const direction = latest ? Math.sign(sample.x - latest.x) : 0;
    const reversed = direction !== 0 && this.direction !== 0 && direction !== this.direction;
    if (direction !== 0) this.direction = direction;
    if (reversed && latest) this.samples = [latest];
    this.samples.push(sample);
    this.trimTo(sample.time - VELOCITY_WINDOW_MS);
    return reversed;
  }

  private trimTo(windowStart: number) {
    while (this.samples.length > 2 && (this.samples[1]?.time ?? windowStart + 1) <= windowStart) this.samples.shift();
  }

  /**
   * Signed speed in px/ms ending at `sample`, from the oldest sample inside
   * the window, or from the sample just before the window when none is inside.
   */
  pxPerMs(sample: SwipeSample) {
    const windowStart = sample.time - VELOCITY_WINDOW_MS;
    const prior = this.samples.filter((entry) => entry.time < sample.time);
    const baseline = prior.find((entry) => entry.time >= windowStart) ?? prior.at(-1);
    if (!baseline) return 0;
    return (sample.x - baseline.x) / Math.max(1, sample.time - baseline.time);
  }
}
