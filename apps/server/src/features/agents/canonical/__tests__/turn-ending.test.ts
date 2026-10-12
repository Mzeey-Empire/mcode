import { describe, expect, it } from "vitest";
import { CanonicalAgentEventSchema } from "@mcode/contracts";
import {
  adapterTurnFailure,
  endingFromAdapterFailure,
  interruptionReason,
  persistTurnFailure,
  providerFailureTerminal,
  withTurnEnding,
} from "../turn-ending.js";

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

describe("providerFailureTerminal", () => {
  it("ends a usage limit as an interruption that keeps the absolute reset and limit window", () => {
    const failure = persistTurnFailure({ failure: { kind: "usage_limit", status: 429, retryAfterMs: 60_000,
      limitType: "five_hour" }, provider: "codex", message: "You've hit your usage limit", acceptedAt: ACCEPTED_AT });

    expect(providerFailureTerminal(failure)).toEqual({ outcome: "interrupted", ending: { cause: "usage_limit",
      usageLimit: { resetsAt: "2026-10-11T12:01:00.000Z", limitType: "five_hour" } } });
  });

  it("records an empty usage limit when the provider reported no reset", () => {
    const failure = persistTurnFailure({ failure: { kind: "usage_limit", code: "upgrade" }, provider: "cursor",
      message: "Upgrade your plan to continue", acceptedAt: ACCEPTED_AT });

    expect(providerFailureTerminal(failure)).toEqual({ outcome: "interrupted",
      ending: { cause: "usage_limit", usageLimit: {} } });
  });

  it("keeps every other failure as an errored ending", () => {
    const failure = persistTurnFailure({ failure: { kind: "auth", status: 401 }, provider: "claude",
      message: "Not signed in", acceptedAt: ACCEPTED_AT });

    expect(providerFailureTerminal(failure)).toEqual({ outcome: "errored", ending: { failure } });
  });
});

describe("withTurnEnding", () => {
  const interrupted = { type: "turn.interrupted", endedAt: "2026-10-11T12:00:00.000Z", reason: "Limit" } as const;

  it("writes the usage limit beside its cause in a payload the canonical schema accepts", () => {
    const payload = withTurnEnding(interrupted, { cause: "usage_limit",
      usageLimit: { resetsAt: "2026-10-11T17:00:00.000Z", limitType: "five_hour" } }, "claude");

    expect(payload).toEqual({ ...interrupted, cause: "usage_limit",
      usageLimit: { resetsAt: "2026-10-11T17:00:00.000Z", limitType: "five_hour" } });
    expect(CanonicalAgentEventSchema.parse(payload)).toEqual(payload);
  });

  it("writes no usage limit for any other interruption cause", () => {
    expect(withTurnEnding(interrupted, { cause: "provider_exited" }, "claude"))
      .toEqual({ ...interrupted, cause: "provider_exited" });
  });
});

describe("adapter failure round trip", () => {
  it("rebuilds and matches a usage-limit classification from its interrupted ending", () => {
    const ending = { cause: "usage_limit", usageLimit: { limitType: "seven_day" } } as const;

    expect(adapterTurnFailure(ending)).toEqual({ kind: "usage_limit", limitType: "seven_day" });
    expect(endingFromAdapterFailure(ending, { kind: "usage_limit", limitType: "seven_day" })).toBe(true);
    expect(endingFromAdapterFailure(ending, { kind: "usage_limit", limitType: "five_hour" })).toBe(false);
    expect(endingFromAdapterFailure(ending, { kind: "fatal" })).toBe(false);
  });
});

describe("interruptionReason", () => {
  it("bounds provider text to the interruption reason limit and defaults blank text", () => {
    expect(interruptionReason("y".repeat(2_500))).toHaveLength(2_000);
    expect(interruptionReason("  ")).toBe("Turn interrupted");
    expect(interruptionReason(undefined)).toBe("Turn interrupted");
  });
});
