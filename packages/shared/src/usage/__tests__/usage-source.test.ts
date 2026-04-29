import { describe, expect, it } from "vitest";
import { NullUsageSource } from "../index.js";

describe("NullUsageSource", () => {
  const source = new NullUsageSource("null");

  it("has a stable id", () => {
    expect(source.id).toBe("null");
  });

  it("is never available", async () => {
    expect(await source.isAvailable()).toBe(false);
  });

  it("always returns null", async () => {
    expect(await source.fetch()).toBeNull();
  });
});
