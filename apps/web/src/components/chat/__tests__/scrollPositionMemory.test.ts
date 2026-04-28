// apps/web/src/components/chat/__tests__/scrollPositionMemory.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberScrollTop,
  recallScrollTop,
  forgetScrollTop,
  clearScrollMemory,
} from "../scrollPositionMemory";

describe("scrollPositionMemory", () => {
  beforeEach(() => clearScrollMemory());

  it("returns undefined for unknown thread", () => {
    expect(recallScrollTop("thread-x")).toBeUndefined();
  });

  it("stores and recalls a scroll position", () => {
    rememberScrollTop("thread-a", 1234);
    expect(recallScrollTop("thread-a")).toBe(1234);
  });

  it("ignores non-finite or negative values", () => {
    rememberScrollTop("thread-a", Number.NaN);
    rememberScrollTop("thread-a", -10);
    rememberScrollTop("thread-a", Number.POSITIVE_INFINITY);
    expect(recallScrollTop("thread-a")).toBeUndefined();
  });

  it("overwrites prior value", () => {
    rememberScrollTop("thread-a", 100);
    rememberScrollTop("thread-a", 200);
    expect(recallScrollTop("thread-a")).toBe(200);
  });

  it("forgets a single thread", () => {
    rememberScrollTop("thread-a", 1);
    rememberScrollTop("thread-b", 2);
    forgetScrollTop("thread-a");
    expect(recallScrollTop("thread-a")).toBeUndefined();
    expect(recallScrollTop("thread-b")).toBe(2);
  });

  it("clearScrollMemory drops everything", () => {
    rememberScrollTop("thread-a", 1);
    clearScrollMemory();
    expect(recallScrollTop("thread-a")).toBeUndefined();
  });
});

describe("scrollPositionMemory — store integration", () => {
  beforeEach(() => clearScrollMemory());

  it("integrates with thread deletion (sanity)", () => {
    rememberScrollTop("thread-deleted", 99);
    forgetScrollTop("thread-deleted");
    expect(recallScrollTop("thread-deleted")).toBeUndefined();
  });
});
