import { RequestError } from "@agentclientprotocol/sdk";
import type { TurnFailure } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { SessionRecoveryFailedError } from "../../../protocols/acp/acp-session-runtime.js";
import { classifyCursorEndTurnNotice, classifyCursorFailure } from "../cursor-failure-classifier.js";

describe("classifyCursorFailure", () => {
  it.each<[unknown, TurnFailure]>([
    [new RequestError(-32000, "Authentication required"), { kind: "auth", code: "-32000" }],
    [
      new RequestError(-32603, "Internal error", { details: "429 Too Many Requests" }),
      { kind: "retryable", status: 429, code: "-32603" },
    ],
    [new Error("post failed with 503 Service Unavailable"), { kind: "retryable", status: 503 }],
    [new Error("v: [resource_exhausted] Error"), { kind: "retryable" }],
    [new Error("ACP connection closed"), { kind: "retryable" }],
    [new RequestError(-32602, "Invalid params"), { kind: "fatal", code: "-32602" }],
    [new SessionRecoveryFailedError(), { kind: "fatal" }],
    [new Error("Unauthorized"), { kind: "fatal" }],
  ])("classifies %o", (error, expected) => {
    expect(classifyCursorFailure(error)).toEqual(expected);
  });
});

// Notice strings are copied verbatim from cursor-agent 2026.04.29-c83a488's
// ACP prompt handler, which appends them and returns stopReason "end_turn".
describe("classifyCursorEndTurnNotice", () => {
  it.each<[string, TurnFailure]>([
    ["Please sign in to continue", { kind: "auth", code: "login" }],
    [
      "Error: [unauthenticated] Backend rejected authentication. Verify this is a User API Key for the same endpoint/environment, then rerun with --debug for request-level auth logs.",
      { kind: "auth", code: "unauthenticated" },
    ],
    ["Upgrade your plan to continue", { kind: "usage_limit", code: "upgrade" }],
    ["Add a payment method to continue", { kind: "usage_limit", code: "payment" }],
    ["Check your settings to continue", { kind: "fatal", code: "config" }],
  ])("classifies the notice %j", (notice, failure) => {
    expect(classifyCursorEndTurnNotice(`Partial answer.\n\n${notice}`)).toEqual({
      reply: "Partial answer.",
      notice,
      failure,
    });
  });

  it("classifies a notice that is the whole reply", () => {
    expect(classifyCursorEndTurnNotice("\n\nUpgrade your plan to continue")).toEqual({
      reply: "",
      notice: "Upgrade your plan to continue",
      failure: { kind: "usage_limit", code: "upgrade" },
    });
  });

  it.each([
    "All done.",
    "Please sign in to continue",
    "Steps:\n\nPlease sign in to continue\n\nThen retry.",
    "Done.\n\nPlease sign in to continue using the dashboard.",
  ])("leaves %j as a normal reply", (text) => {
    expect(classifyCursorEndTurnNotice(text)).toBeUndefined();
  });
});
