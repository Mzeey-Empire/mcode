import { describe, expect, it } from "vitest";
import { SwipeVelocity } from "../swipe-velocity";

describe("SwipeVelocity", () => {
  it("reads a fast flick at the end of a long hold", () => {
    const velocity = new SwipeVelocity();
    velocity.reset({ x: 0, time: 0 });
    velocity.track({ x: 2, time: 1000 });
    velocity.track({ x: 40, time: 1010 });
    velocity.track({ x: 82, time: 1050 });

    // 80px over the last 50ms; averaging from the press would give 0.08.
    expect(velocity.pxPerMs({ x: 82, time: 1050 })).toBeCloseTo(1.6);
  });

  it("reads a slow steady drag as slow", () => {
    const velocity = new SwipeVelocity();
    velocity.reset({ x: 0, time: 0 });
    for (let time = 16; time <= 480; time += 16) velocity.track({ x: time / 4, time });

    expect(velocity.pxPerMs({ x: 120, time: 480 })).toBeCloseTo(0.25);
  });

  it("reads a flick when the first move after a hold is also the last", () => {
    const velocity = new SwipeVelocity();
    velocity.reset({ x: 0, time: 0 });
    velocity.track({ x: 20, time: 1000 });

    expect(velocity.pxPerMs({ x: 80, time: 1020 })).toBeCloseTo(3);
  });

  it("reads a pause before release as no flick", () => {
    const velocity = new SwipeVelocity();
    velocity.reset({ x: 0, time: 0 });
    velocity.track({ x: 60, time: 40 });

    expect(velocity.pxPerMs({ x: 60, time: 300 })).toBe(0);
  });
});
