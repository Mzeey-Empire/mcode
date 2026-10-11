import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { acpRequestErrorCode, describeAcpError } from "../acp-request-error.js";

describe("describeAcpError", () => {
  it.each([
    [new RequestError(-32603, "Internal error", { details: "429 Too Many Requests" }), "Internal error: 429 Too Many Requests"],
    [new RequestError(-32603, "Internal error", "upstream reset"), "Internal error: upstream reset"],
    [new RequestError(-32602, "Invalid params", { field: "sessionId" }), "Invalid params: {\"field\":\"sessionId\"}"],
    [new RequestError(-32000, "Authentication required"), "Authentication required"],
    [
      // Captured from cursor-agent acp newSession while signed out.
      new RequestError(-32000, "Authentication required", {
        message: "Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
      }),
      "Authentication required: Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.",
    ],
    [new RequestError(-32603, "Internal error", {}), "Internal error"],
    [new RequestError(-32603, "Internal error", "Internal error"), "Internal error"],
    [new Error("ACP connection closed"), "ACP connection closed"],
    ["plain text", "plain text"],
  ])("describes %o as %j", (error, expected) => {
    expect(describeAcpError(error)).toBe(expected);
  });

  it("caps appended detail at 2,000 characters", () => {
    const description = describeAcpError(new RequestError(-32603, "Internal error", "x".repeat(5_000)));

    expect(description).toBe(`Internal error: ${"x".repeat(2_000)}`);
  });
});

describe("acpRequestErrorCode", () => {
  it("reads the code only from ACP request errors", () => {
    expect(acpRequestErrorCode(new RequestError(-32000, "Authentication required"))).toBe(-32000);
    expect(acpRequestErrorCode(Object.assign(new Error("lookalike"), { code: -32000 }))).toBeUndefined();
  });
});
