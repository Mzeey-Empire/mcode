import { describe, expect, it } from "vitest";
import type { AgentTurnEnding, InterruptionCause, PersistedTurnFailure } from "@mcode/contracts/compat/agent-model";
import { turnEndingView, type TurnEndingInput } from "../turn-ending-notice";

const STARTED = "2026-10-11T10:00:00.000Z";

function input(overrides: Partial<TurnEndingInput> = {}): TurnEndingInput {
  return {
    status: "errored",
    ending: null,
    providerStartedAt: STARTED,
    durationMs: 42_000,
    providerLabel: "Codex",
    providerSignedOut: false,
    isStartupTurn: false,
    isLatestTurn: true,
    executionId: "exec1234abcd",
    ...overrides,
  };
}

function errored(failure: Partial<PersistedTurnFailure> & Pick<PersistedTurnFailure, "kind">): AgentTurnEnding {
  return { outcome: "errored", failure: { provider: "codex", message: "upstream said no\nstack line", ...failure } };
}

const localIso = (hour: number, minute: number) => new Date(2026, 9, 11, hour, minute).toISOString();

describe("turnEndingView: cancelled", () => {
  it("shows no notice for a completed turn", () => {
    expect(turnEndingView(input({ status: "completed" }))).toEqual({ foldLabel: "Worked for 42s", notice: null });
  });

  it("reads a user stop after the provider started", () => {
    const view = turnEndingView(input({ status: "cancelled", ending: { outcome: "cancelled", stop: { by: "user" } } }));
    expect(view).toEqual({ foldLabel: "Stopped after 42s", notice: { style: "quiet", title: "You stopped" } });
  });

  it("treats a null ending as a user stop", () => {
    expect(turnEndingView(input({ status: "cancelled" })).notice).toEqual({ style: "quiet", title: "You stopped" });
  });

  it("names the provider when the stop came before it started, with no fold", () => {
    const view = turnEndingView(input({ status: "cancelled", providerStartedAt: null }));
    expect(view).toEqual({ foldLabel: null, notice: { style: "quiet", title: "Stopped before Codex started" } });
  });

  it("hides the startup turn's ending until the provider started", () => {
    expect(turnEndingView(input({ status: "cancelled", providerStartedAt: null, isStartupTurn: true }))).toEqual({ foldLabel: null, notice: null });
    expect(turnEndingView(input({ status: "errored", providerStartedAt: null, isStartupTurn: true }))).toEqual({ foldLabel: null, notice: null });
  });

  it.each([
    ["approval_unanswerable", { style: "quiet", title: "Stopped by Mcode", detail: "Mcode couldn't answer an approval request" }],
    ["thread_control", { style: "quiet", title: "Stopped by another thread" }],
    ["thread_deleted", null],
  ] as const)("maps a Mcode stop for %s", (reason, notice) => {
    const view = turnEndingView(input({ status: "cancelled", ending: { outcome: "cancelled", stop: { by: "mcode", reason } } }));
    expect(view.notice).toEqual(notice);
  });
});

describe("turnEndingView: interrupted", () => {
  const interrupted = (cause: InterruptionCause): AgentTurnEnding => ({ outcome: "interrupted", cause });

  it.each([
    ["app_closed", "Mcode closed while Codex was working"],
    ["provider_exited", "Codex stopped unexpectedly"],
    ["saving_stopped", "Mcode stopped saving Codex's output"],
    ["unknown", "Codex stopped before finishing"],
  ] as const)("names the %s cause and offers Resume", (cause, detail) => {
    expect(turnEndingView(input({ status: "interrupted", ending: interrupted(cause) }))).toEqual({
      foldLabel: "Interrupted after 42s",
      notice: { style: "filled", icon: "interrupted", title: "Interrupted", detail, primary: { action: "resume", label: "Resume" } },
    });
  });

  it("reads a row written before causes existed as unknown", () => {
    expect(turnEndingView(input({ status: "interrupted" })).notice).toMatchObject({ detail: "Codex stopped before finishing" });
  });

  it("offers Resume only on the thread's latest turn", () => {
    const notice = turnEndingView(input({ status: "interrupted", isLatestTurn: false, ending: interrupted("app_closed") })).notice;
    expect(notice).toEqual({ style: "filled", icon: "interrupted", title: "Interrupted", detail: "Mcode closed while Codex was working" });
  });

  it.each([true, false])("records a usage limit as a quiet stop whose actions live in the composer (latest: %s)", (isLatestTurn) => {
    const ending: AgentTurnEnding = { outcome: "interrupted", cause: "usage_limit", usageLimit: { resetsAt: localIso(14, 5), limitType: "five_hour" } };
    expect(turnEndingView(input({ status: "interrupted", isLatestTurn, ending }))).toEqual({
      foldLabel: "Interrupted after 42s",
      notice: { style: "quiet", icon: "paused", title: "Interrupted · Codex usage limit" },
    });
  });

  it("drops the fold when the provider never started, and defers the startup turn to its trail", () => {
    const ending = interrupted("app_closed");
    expect(turnEndingView(input({ status: "interrupted", ending, providerStartedAt: null })).foldLabel).toBeNull();
    expect(turnEndingView(input({ status: "interrupted", ending, providerStartedAt: null, isStartupTurn: true }))).toEqual({ foldLabel: null, notice: null });
  });
});

describe("turnEndingView: errored", () => {
  it("names the status and retry count for a retryable failure", () => {
    const view = turnEndingView(input({ ending: errored({ kind: "retryable", status: 529, retries: { made: 3 } }) }));
    expect(view).toEqual({
      foldLabel: "Failed after 42s",
      notice: {
        style: "filled",
        icon: "failed",
        title: "Codex stopped responding",
        detail: "Overloaded after 3 retries",
        details: "upstream said no\nstack line\nturn exec1234",
        primary: { action: "retry", label: "Retry" },
      },
    });
  });

  it.each([
    [{ status: 503, retries: { made: 1 } }, "Service Unavailable after 1 retry"],
    [{ status: 502 }, "Bad Gateway"],
    [{ status: 418 }, "upstream said no"],
    [{}, "upstream said no"],
  ])("words retryable detail %o as %s", (fields, detail) => {
    expect(turnEndingView(input({ ending: errored({ kind: "retryable", ...fields }) })).notice).toMatchObject({ detail });
  });

  it("offers Retry on a fatal failure with the message's first line", () => {
    expect(turnEndingView(input({ ending: errored({ kind: "fatal" }) })).notice).toEqual({
      style: "filled",
      icon: "failed",
      title: "Codex couldn't finish this turn",
      detail: "upstream said no",
      details: "upstream said no\nstack line\nturn exec1234",
      primary: { action: "retry", label: "Retry" },
    });
  });

  it("offers Retry on an unclassified failure", () => {
    expect(turnEndingView(input()).notice).toEqual({
      style: "filled",
      icon: "failed",
      title: "Codex couldn't finish this turn",
      primary: { action: "retry", label: "Retry" },
    });
  });

  it("drops the primary action when a later turn exists", () => {
    const notice = turnEndingView(input({ isLatestTurn: false, ending: errored({ kind: "fatal" }) })).notice;
    expect(notice).not.toHaveProperty("primary");
  });

  it("omits the turn line when there is no execution id", () => {
    expect(turnEndingView(input({ executionId: null, ending: errored({ kind: "fatal" }) })).notice).toMatchObject({ details: "upstream said no\nstack line" });
  });

  it.each([
    [false, { action: "retry", label: "Retry" }],
    [true, { action: "sign_in", label: "Sign in" }],
  ] as const)("offers the right auth action when signed out is %s", (providerSignedOut, primary) => {
    expect(turnEndingView(input({ providerSignedOut, ending: errored({ kind: "auth" }) })).notice).toEqual({
      style: "filled",
      icon: "failed",
      title: "Codex is signed out",
      detail: "Threads on Codex can't run until you sign in",
      primary,
    });
  });

  it("keeps plain Retry for a usage-limit failure written before usage limits became interruptions", () => {
    const view = turnEndingView(input({ ending: errored({ kind: "usage_limit", limitType: "five_hour", resetsAt: localIso(14, 5) }) }));
    expect(view.notice).toEqual({
      style: "filled",
      icon: "failed",
      title: "Codex usage limit reached",
      detail: "5-hour limit",
      details: "upstream said no\nstack line\nturn exec1234",
      primary: { action: "retry", label: "Retry" },
    });
  });

  it.each([
    [{}, undefined],
    [{ limitType: "seven_day" }, "Weekly limit"],
    [{ limitType: "monthly" }, "monthly"],
  ])("names the usage-limit window %o on an old failure", (fields, detail) => {
    const notice = turnEndingView(input({ ending: errored({ kind: "usage_limit", ...fields }) })).notice;
    expect(notice).toMatchObject({ primary: { action: "retry", label: "Retry" } });
    expect(notice?.detail).toBe(detail);
  });
});
