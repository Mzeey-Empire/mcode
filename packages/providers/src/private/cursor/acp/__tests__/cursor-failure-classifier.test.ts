import { RequestError } from "@agentclientprotocol/sdk";
import type { TurnFailure } from "@mcode/contracts";
import { describe, expect, it } from "vitest";
import { SessionRecoveryFailedError } from "../../../protocols/acp/acp-session-runtime.js";
import { classifyCursorFailure } from "../cursor-failure-classifier.js";

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
    [
      new RequestError(-32603, "Internal error", { details: "You've hit your usage limit" }),
      { kind: "usage_limit", code: "-32603" },
    ],
    [new RequestError(-32602, "Invalid params"), { kind: "fatal", code: "-32602" }],
    [new SessionRecoveryFailedError(), { kind: "fatal" }],
    [new Error("Unauthorized"), { kind: "fatal" }],
  ])("classifies %o", (error, expected) => {
    expect(classifyCursorFailure(error)).toEqual(expected);
  });
});
