import { expect, test } from "bun:test";

import { createFramePacer } from "./record-video.mjs";

test("holds the previous frame across an idle gap", () => {
  const pacer = createFramePacer(25);
  const a = Buffer.from("A");
  const b = Buffer.from("B");

  const output = [
    ...pacer.push({ image: a, at: 100.0 }),
    ...pacer.push({ image: b, at: 102.0 }),
    ...pacer.finish(102.0),
  ];

  expect(output).toEqual([...Array(50).fill(a), b]);
});

test("holds the last frame across an idle tail", () => {
  const pacer = createFramePacer(25);
  const a = Buffer.from("A");

  const output = [
    ...pacer.push({ image: a, at: 100.0 }),
    ...pacer.finish(103.0),
  ];

  expect(output).toEqual(Array(75).fill(a));
});

test("reduces a burst to one frame per elapsed slot, then the newest image", () => {
  const pacer = createFramePacer(25);
  const frames = Array.from({ length: 30 }, (_, index) => Buffer.from(String(index)));
  const output = [];

  for (let index = 0; index < frames.length; index += 1) {
    output.push(...pacer.push({ image: frames[index], at: 100.0 + index / 29 * 0.1 }));
  }
  output.push(...pacer.finish(100.1));

  expect(output).toEqual([Buffer.from("0"), Buffer.from("11"), Buffer.from("23"), Buffer.from("29")]);
});

test("accepts a late frame and uses it for the remaining slots", () => {
  const pacer = createFramePacer(25);
  const a = Buffer.from("A");
  const b = Buffer.from("B");

  const first = pacer.push({ image: a, at: 101.0 });
  const late = pacer.push({ image: b, at: 100.9 });
  const tail = pacer.finish(101.2);

  expect(first).toEqual([]);
  expect(late).toEqual([]);
  expect(tail).toEqual(Array(5).fill(b));
});

test("absorbs floating-point noise at a slot boundary", () => {
  const pacer = createFramePacer(10);
  const a = Buffer.from("A");
  const b = Buffer.from("B");

  const output = [
    ...pacer.push({ image: a, at: 0 }),
    ...pacer.push({ image: b, at: 0.3 }),
    ...pacer.finish(0.3),
  ];

  expect(output).toEqual([a, a, a, b]);
});

test("returns no output when no frames arrived", () => {
  const pacer = createFramePacer(25);

  expect(pacer.finish(1.0)).toEqual([]);
});
