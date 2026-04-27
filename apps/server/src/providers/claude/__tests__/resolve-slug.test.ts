import { describe, it, expect } from "vitest";
import { resolveSdkModelSlug, applyUltrathinkPrefix } from "../resolve-slug.js";

describe("resolveSdkModelSlug", () => {
  // ---------------------------------------------------------------------------
  // 1M opt-in: append [1m] suffix for supported models
  // ---------------------------------------------------------------------------

  it("appends [1m] for opus-4-7 in 1m mode", () => {
    expect(resolveSdkModelSlug("claude-opus-4-7", "1m")).toBe("claude-opus-4-7[1m]");
  });

  it("appends [1m] for opus-4-6 in 1m mode", () => {
    expect(resolveSdkModelSlug("claude-opus-4-6", "1m")).toBe("claude-opus-4-6[1m]");
  });

  it("appends [1m] for sonnet-4-6 in 1m mode", () => {
    expect(resolveSdkModelSlug("claude-sonnet-4-6", "1m")).toBe("claude-sonnet-4-6[1m]");
  });

  it("appends [1m] for dated sonnet-4-6 variant in 1m mode", () => {
    expect(resolveSdkModelSlug("claude-sonnet-4-6-20260301", "1m")).toBe(
      "claude-sonnet-4-6-20260301[1m]",
    );
  });

  // ---------------------------------------------------------------------------
  // No suffix for unsupported models
  // ---------------------------------------------------------------------------

  it("returns bare slug for haiku-4-5 in 1m mode (not supported)", () => {
    expect(resolveSdkModelSlug("claude-haiku-4-5", "1m")).toBe("claude-haiku-4-5");
  });

  it("returns bare slug for unknown model in 1m mode", () => {
    expect(resolveSdkModelSlug("claude-future-model", "1m")).toBe("claude-future-model");
  });

  // ---------------------------------------------------------------------------
  // 200k mode + undefined: never appends suffix
  // ---------------------------------------------------------------------------

  it("returns bare slug for sonnet-4-6 in 200k mode", () => {
    expect(resolveSdkModelSlug("claude-sonnet-4-6", "200k")).toBe("claude-sonnet-4-6");
  });

  it("returns bare slug for sonnet-4-6 with undefined mode", () => {
    expect(resolveSdkModelSlug("claude-sonnet-4-6", undefined)).toBe("claude-sonnet-4-6");
  });
});

describe("applyUltrathinkPrefix", () => {
  // ---------------------------------------------------------------------------
  // Prefix applied for ultrathink + supported model
  // ---------------------------------------------------------------------------

  it("prepends 'Ultrathink:\\n' for opus-4-7 + ultrathink", () => {
    expect(applyUltrathinkPrefix("hello", "ultrathink", "claude-opus-4-7")).toBe(
      "Ultrathink:\nhello",
    );
  });

  it("prepends 'Ultrathink:\\n' for sonnet-4-6 + ultrathink", () => {
    expect(applyUltrathinkPrefix("hello", "ultrathink", "claude-sonnet-4-6")).toBe(
      "Ultrathink:\nhello",
    );
  });

  it("prepends 'Ultrathink:\\n' for opus-4-6 + ultrathink", () => {
    expect(applyUltrathinkPrefix("hello", "ultrathink", "claude-opus-4-6")).toBe(
      "Ultrathink:\nhello",
    );
  });

  // ---------------------------------------------------------------------------
  // Prefix skipped for unsupported model (Haiku) or non-ultrathink levels
  // ---------------------------------------------------------------------------

  it("does not prepend for haiku-4-5 (ultrathink unsupported)", () => {
    expect(applyUltrathinkPrefix("hello", "ultrathink", "claude-haiku-4-5")).toBe("hello");
  });

  it("does not prepend when level is 'max'", () => {
    expect(applyUltrathinkPrefix("hello", "max", "claude-opus-4-7")).toBe("hello");
  });

  it("does not prepend when level is 'high'", () => {
    expect(applyUltrathinkPrefix("hello", "high", "claude-sonnet-4-6")).toBe("hello");
  });

  it("does not prepend when level is undefined", () => {
    expect(applyUltrathinkPrefix("hello", undefined, "claude-sonnet-4-6")).toBe("hello");
  });

  // ---------------------------------------------------------------------------
  // Idempotency: do not double-prefix
  // ---------------------------------------------------------------------------

  it("does not double-prefix an already-prefixed message", () => {
    expect(
      applyUltrathinkPrefix("Ultrathink:\nhello", "ultrathink", "claude-opus-4-7"),
    ).toBe("Ultrathink:\nhello");
  });
});
