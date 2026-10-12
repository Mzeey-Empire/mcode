import { describe, expect, it } from "vitest";
import { ScheduledTurnRetrySchema, ThreadSchema, WS_CHANNELS, WS_METHODS } from "../index.js";

describe("turn recovery contracts", () => {
  const scheduled = { turnId: "turn-1", at: "2026-10-11T16:00:00+01:00" };

  it("carries scheduled retries through RPC results, pushes and thread reloads", () => {
    expect(ScheduledTurnRetrySchema().parse(scheduled)).toEqual(scheduled);
    expect(WS_METHODS()["turn.retry.schedule"].params.parse({ threadId: "thread-1", ...scheduled }))
      .toEqual({ threadId: "thread-1", ...scheduled });
    expect(WS_METHODS()["turn.retry.schedule"].result.parse(scheduled)).toEqual(scheduled);
    expect(WS_CHANNELS["thread.retryScheduled"].parse({ threadId: "thread-1", retry: scheduled }))
      .toEqual({ threadId: "thread-1", retry: scheduled });
    expect(ThreadSchema().shape.scheduled_retry.parse(scheduled)).toEqual(scheduled);
    expect(ThreadSchema().shape.scheduled_retry.parse(null)).toBeNull();
  });

  it.each([{ at: "2026-10-11T16:00:00" }, { at: "tomorrow" }, { turnId: "" }, { extra: true }])(
    "rejects invalid scheduled retry %j", (invalid) => {
      expect(ScheduledTurnRetrySchema().safeParse({ ...scheduled, ...invalid }).success).toBe(false);
      expect(WS_METHODS()["turn.retry.schedule"].params.safeParse({ threadId: "thread-1", ...scheduled, ...invalid }).success).toBe(false);
    },
  );

  it("validates cancellation and its null push", () => {
    const cancel = WS_METHODS()["turn.retry.unschedule"];
    expect(cancel.params.parse({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(cancel.params.safeParse({ threadId: "thread-1", turnId: "turn-1" }).success).toBe(false);
    expect(cancel.params.safeParse({ threadId: "" }).success).toBe(false);
    expect(cancel.result.parse(undefined)).toBeUndefined();
    expect(WS_CHANNELS["thread.retryScheduled"].parse({ threadId: "thread-1", retry: null }))
      .toEqual({ threadId: "thread-1", retry: null });
  });
  it("validates retry input and trims the optional model", () => {
    const retry = WS_METHODS()["turn.retry"];
    expect(retry.params.parse({ threadId: "thread-1", turnId: "turn-1", model: "  replacement  " }))
      .toEqual({ threadId: "thread-1", turnId: "turn-1", model: "replacement" });
    expect(retry.params.parse({ threadId: "thread-1", turnId: "turn-1" }))
      .toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(retry.result.parse({ turnId: "turn-2" })).toEqual({ turnId: "turn-2" });
    expect(retry.result.safeParse({ turnId: "turn-2", extra: true }).success).toBe(false);
    expect(retry.result.safeParse({ turnId: "" }).success).toBe(false);
  });

  it.each([
    { threadId: "" }, { threadId: "t".repeat(257) }, { turnId: "" },
    { model: " " }, { model: "m".repeat(257) }, { extra: true },
  ])("rejects invalid retry input %j", (invalid) => {
    expect(WS_METHODS()["turn.retry"].params.safeParse({
      threadId: "thread-1", turnId: "turn-1", ...invalid,
    }).success).toBe(false);
  });

  it("validates resume input and reports the continuation mode", () => {
    const resume = WS_METHODS()["turn.resume"];
    expect(resume.params.parse({ threadId: "thread-1", turnId: "turn-1" }))
      .toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(resume.params.safeParse({ threadId: "thread-1", turnId: "turn-1", model: "m" }).success).toBe(false);
    expect(resume.params.safeParse({ threadId: "", turnId: "turn-1" }).success).toBe(false);
    expect(resume.result.parse({ turnId: "turn-2", mode: "native-session" }))
      .toEqual({ turnId: "turn-2", mode: "native-session" });
    expect(resume.result.parse({ turnId: "turn-2", mode: "seeded-session" }).mode).toBe("seeded-session");
    expect(resume.result.safeParse({ turnId: "turn-2", mode: "fresh" }).success).toBe(false);
  });
});
