import { describe, it, expect } from "vitest";
import {
  isLikelyFinalResponseTail,
  type NarrationSegmentTailInput,
} from "../narration-segment.js";

const seg = (text: string, sortOrder: number): NarrationSegmentTailInput => ({
  text,
  sortOrder,
});

describe("isLikelyFinalResponseTail", () => {
  it("returns false when the message body is empty", () => {
    const s = seg("anything", 0);
    expect(isLikelyFinalResponseTail(s, [s], "")).toBe(false);
    expect(isLikelyFinalResponseTail(s, [s], "   ")).toBe(false);
  });

  it("returns false for an empty/whitespace segment", () => {
    const s = seg("   ", 0);
    expect(isLikelyFinalResponseTail(s, [s], "hello")).toBe(false);
  });

  it("matches when segment text equals the body, regardless of position", () => {
    const a = seg("final answer", 5);
    const b = seg("intro narration", 1);
    expect(isLikelyFinalResponseTail(a, [a, b], "final answer")).toBe(true);
    // Whitespace-insensitive on both sides.
    expect(isLikelyFinalResponseTail(seg("  final answer  ", 5), [a, b], "final answer\n"))
      .toBe(true);
  });

  it("matches the tail segment when the body ends with it", () => {
    const intro = seg("Let me check the file.", 1);
    const tail = seg("Here is what I found.", 3);
    const body = "Let me check the file.\n\n[tool calls happen]\n\nHere is what I found.";
    expect(isLikelyFinalResponseTail(tail, [intro, tail], body)).toBe(true);
  });

  it("does NOT match a non-tail segment even if the body ends with its text", () => {
    // Same text appears twice — only the chronologically last one should match.
    const earlier = seg("Done.", 1);
    const tail = seg("All set.", 3);
    const body = "Earlier I said... All set.";
    expect(isLikelyFinalResponseTail(earlier, [earlier, tail], body)).toBe(false);
  });

  it("does NOT match when the tail segment is unrelated to the body", () => {
    const tail = seg("about to call a tool", 2);
    expect(isLikelyFinalResponseTail(tail, [tail], "the final answer is 42")).toBe(false);
  });

  it("matches a single-segment tool-free turn", () => {
    const only = seg("The answer is 42.", 0);
    expect(isLikelyFinalResponseTail(only, [only], "The answer is 42.")).toBe(true);
  });

  it("identifies the tail strictly by max sortOrder across 3+ segments", () => {
    // Three segments; only the one with the highest sortOrder qualifies as tail
    // even when an earlier segment's text also matches the body suffix.
    const tailText = "matches the body.";
    const a = seg("early reasoning", 1);
    const b = seg(tailText, 2);
    const c = seg(tailText, 5); // the real tail
    const body = `Stuff happened. ${tailText}`;
    expect(isLikelyFinalResponseTail(c, [a, b, c], body)).toBe(true);
    // `b` carries the same text but is not the tail — should NOT match on the
    // suffix-tail rule (the exact-equality branch also doesn't apply because
    // `tailText !== body.trim()`).
    expect(isLikelyFinalResponseTail(b, [a, b, c], body)).toBe(false);
  });

  it("does NOT match when the segment is a prefix (not suffix) of the body", () => {
    const tail = seg("starts the message", 1);
    const body = "starts the message and continues on after this.";
    expect(isLikelyFinalResponseTail(tail, [tail], body)).toBe(false);
  });
});
