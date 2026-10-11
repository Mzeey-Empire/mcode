import { describe, expect, it } from "vitest";
import { enrichHandshakeError } from "../../private/codex/codex-app-server.js";
import { classifyCodexFailure, classifyCodexLocalFailure, readCodexErrorInfo } from "../../private/codex/codex-failure-classifier.js";
import { CodexRpcResponseError, CodexTransportError } from "../../private/codex/codex-rpc-client.js";

const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;

describe("classifyCodexFailure", () => {
  it.each([
    ["usageLimitExceeded", "usage_limit"],
    ["unauthorized", "auth"],
    ["rateLimitExceeded", "retryable"],
    ["serverOverloaded", "retryable"],
    ["internalServerError", "retryable"],
    ["contextWindowExceeded", "fatal"],
    ["sessionBudgetExceeded", "fatal"],
    ["flexUnavailable", "retryable"],
    ["badRequest", "fatal"],
    ["cyberPolicy", "fatal"],
    ["sandboxError", "fatal"],
    ["somethingNew", "fatal"],
  ])("classifies %s as %s", (codexErrorInfo, kind) => {
    expect(classifyCodexFailure({ codexErrorInfo }, NOW)).toEqual({ kind, code: codexErrorInfo });
  });

  it.each(["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"])(
    "classifies %s by its forwarded status",
    (name) => {
      const classify = (httpStatusCode: number | null) => classifyCodexFailure({ codexErrorInfo: { [name]: { httpStatusCode } } }, NOW).kind;
      expect(classify(401)).toBe("auth");
      expect(classify(403)).toBe("fatal");
      expect(classify(404)).toBe("fatal");
      expect(classify(408)).toBe("retryable");
      expect(classify(429)).toBe("retryable");
      expect(classify(502)).toBe("retryable");
      expect(classify(null)).toBe("retryable");
    },
  );

  it("sends an expired API key to sign-in rather than retry", () => {
    expect(classifyCodexFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, NOW))
      .toEqual({ kind: "auth", status: 401, code: "httpConnectionFailed" });
  });

  it("treats the untagged fallback and missing info as fatal without a code", () => {
    expect(classifyCodexFailure({ codexErrorInfo: "other" }, NOW)).toEqual({ kind: "fatal" });
    expect(classifyCodexFailure({ codexErrorInfo: null }, NOW)).toEqual({ kind: "fatal" });
    expect(classifyCodexFailure({}, NOW)).toEqual({ kind: "fatal" });
  });

  it("names a non-steerable turn without treating its payload as a status", () => {
    expect(classifyCodexFailure({ codexErrorInfo: { activeTurnNotSteerable: { turnKind: "review" } } }, NOW))
      .toEqual({ kind: "fatal", code: "activeTurnNotSteerable" });
  });

  it("waits for the fullest window and labels known window lengths", () => {
    const rateLimits = {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW_SECONDS + 60 },
      secondary: { usedPercent: 70, windowDurationMins: 10_080, resetsAt: NOW_SECONDS + 86_400 },
    };
    expect(classifyCodexFailure({ codexErrorInfo: "usageLimitExceeded", rateLimits }, NOW))
      .toEqual({ kind: "usage_limit", code: "usageLimitExceeded", retryAfterMs: 60_000, limitType: "five_hour" });
  });

  it("breaks a usage tie with the later reset and omits an unknown window label", () => {
    const rateLimits = {
      primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: NOW_SECONDS + 600 },
      secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: NOW_SECONDS + 7_200 },
    };
    expect(classifyCodexFailure({ codexErrorInfo: "usageLimitExceeded", rateLimits }, NOW))
      .toEqual({ kind: "usage_limit", code: "usageLimitExceeded", retryAfterMs: 7_200_000, limitType: "seven_day" });
    expect(classifyCodexFailure({ codexErrorInfo: "usageLimitExceeded", rateLimits: { primary: rateLimits.primary } }, NOW))
      .toEqual({ kind: "usage_limit", code: "usageLimitExceeded", retryAfterMs: 600_000 });
  });

  it("gives no wait when no window is full and still blocking", () => {
    const usageLimit = { kind: "usage_limit", code: "usageLimitExceeded" };
    expect(classifyCodexFailure({ codexErrorInfo: "usageLimitExceeded", rateLimits: { primary: { usedPercent: 100, resetsAt: NOW_SECONDS - 5 } } }, NOW))
      .toEqual(usageLimit);
    expect(classifyCodexFailure({ codexErrorInfo: "usageLimitExceeded", rateLimits: { primary: { usedPercent: 100, resetsAt: NOW_SECONDS } } }, NOW))
      .toEqual(usageLimit);
    // A quota or plan-upgrade error shares usageLimitExceeded while the plan windows are not full.
    expect(classifyCodexFailure({ codexErrorInfo: "usageLimitExceeded", rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: NOW_SECONDS + 60 } } }, NOW))
      .toEqual(usageLimit);
    expect(classifyCodexFailure({ codexErrorInfo: "usageLimitExceeded", rateLimits: { primary: null, secondary: null } }, NOW))
      .toEqual({ kind: "usage_limit", code: "usageLimitExceeded" });
  });

  it("keeps account windows off failures that are not usage limits", () => {
    const rateLimits = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW_SECONDS + 60 } };
    expect(classifyCodexFailure({ codexErrorInfo: "rateLimitExceeded", rateLimits }, NOW)).toEqual({ kind: "retryable", code: "rateLimitExceeded" });
  });

  it("reports retries only when Codex announced some", () => {
    expect(classifyCodexFailure({ codexErrorInfo: "serverOverloaded", retriesMade: 3 }, NOW))
      .toEqual({ kind: "retryable", code: "serverOverloaded", retries: { made: 3 } });
    expect(classifyCodexFailure({ codexErrorInfo: "serverOverloaded", retriesMade: 0 }, NOW)).toEqual({ kind: "retryable", code: "serverOverloaded" });
  });
});

describe("readCodexErrorInfo", () => {
  it("accepts only real HTTP statuses", () => {
    expect(readCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 99 } })).toEqual({ code: "httpConnectionFailed", status: undefined });
    expect(readCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 100 } })).toEqual({ code: "httpConnectionFailed", status: 100 });
    expect(readCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 599 } })).toEqual({ code: "httpConnectionFailed", status: 599 });
    expect(readCodexErrorInfo({ httpConnectionFailed: { httpStatusCode: 600 } })).toEqual({ code: "httpConnectionFailed", status: undefined });
  });

  it("ignores objects that are not a single variant", () => {
    expect(readCodexErrorInfo({})).toEqual({});
    expect(readCodexErrorInfo({ badRequest: null, unauthorized: null })).toEqual({});
    expect(readCodexErrorInfo(["unauthorized"])).toEqual({});
  });
});

describe("classifyCodexLocalFailure", () => {
  it("treats a lost or timed-out connection as retryable, even after stderr is folded in", () => {
    expect(classifyCodexLocalFailure(new CodexTransportError("Stream closed while waiting for response"))).toEqual({ kind: "retryable" });
    const handshake = enrichHandshakeError(new CodexTransportError("Timed out waiting for initialize (30000ms)"), "auth refresh slow");
    expect(classifyCodexLocalFailure(handshake)).toEqual({ kind: "retryable" });
  });

  it("treats a refused request as fatal and keeps its JSON-RPC code", () => {
    expect(classifyCodexLocalFailure(new CodexRpcResponseError("Invalid params", -32602))).toEqual({ kind: "fatal", code: "-32602" });
    expect(classifyCodexLocalFailure(enrichHandshakeError(new CodexRpcResponseError("Not logged in"), "boom"))).toEqual({ kind: "fatal" });
  });

  it("treats any other local error as fatal", () => {
    expect(classifyCodexLocalFailure(new Error("sendTurn called before thread was established"))).toEqual({ kind: "fatal" });
    expect(classifyCodexLocalFailure("not an error")).toEqual({ kind: "fatal" });
  });
});
