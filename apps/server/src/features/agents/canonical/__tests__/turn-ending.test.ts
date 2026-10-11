import { describe, expect, it } from "vitest";
import { persistTurnFailure } from "../turn-ending.js";

const ACCEPTED_AT = Date.parse("2026-10-11T12:00:00.000Z");

describe("persistTurnFailure", () => {
  it("stores a relative retry wait as an absolute reset time from acceptance", () => {
    const failure = persistTurnFailure({ failure: { kind: "usage_limit", retryAfterMs: 90_000 },
      provider: "claude", message: "Limit reached", acceptedAt: ACCEPTED_AT });

    expect(failure).toEqual({ kind: "usage_limit", provider: "claude", message: "Limit reached",
      resetsAt: "2026-10-11T12:01:30.000Z" });
  });

  it("falls back to the last observed retries only when the adapter reported none", () => {
    const lastRetries = { made: 4, max: 5 };
    const observed = persistTurnFailure({ failure: { kind: "retryable" }, provider: "codex", message: "Overloaded",
      acceptedAt: ACCEPTED_AT, lastRetries });
    const reported = persistTurnFailure({ failure: { kind: "retryable", retries: { made: 1 } }, provider: "codex",
      message: "Overloaded", acceptedAt: ACCEPTED_AT, lastRetries });

    expect(observed.retries).toEqual({ made: 4, max: 5 });
    expect(reported.retries).toEqual({ made: 1 });
  });

  it("bounds the persisted message to 8,000 characters", () => {
    const failure = persistTurnFailure({ failure: { kind: "fatal" }, provider: "codex",
      message: "x".repeat(9_000), acceptedAt: ACCEPTED_AT });

    expect(failure.message).toHaveLength(8_000);
  });
});
