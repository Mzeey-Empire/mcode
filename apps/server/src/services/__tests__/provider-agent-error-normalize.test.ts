import { describe, expect, it } from "vitest";
import { normalizeAgentProviderError } from "../provider-agent-error-normalize.js";

describe("normalizeAgentProviderError", () => {
  it("wraps vague Cursor upstream 5xx payloads", () => {
    const raw = "Internal Server Error";
    expect(normalizeAgentProviderError("cursor", raw)).toContain(raw);
    expect(normalizeAgentProviderError("cursor", raw)).toContain(
      "The Cursor CLI reported an upstream error",
    );
  });

  it("does not wrap the same wording for Claude", () => {
    const raw = "Internal Server Error";
    expect(normalizeAgentProviderError("claude", raw)).toBe(raw);
  });

  it("keeps ENOENT mapping for Claude", () => {
    expect(normalizeAgentProviderError("claude", "spawn foobar ENOENT")).toContain(
      "Claude CLI not found",
    );
  });

  it("handles HTTP-style status wording for Cursor", () => {
    const raw = "Request failed status code: 503";
    const out = normalizeAgentProviderError("cursor", raw);
    expect(out).toContain(raw);
    expect(out).toContain("upstream error");
  });

  it("does not recursively wrap Cursor upstream errors once contextualized", () => {
    const once = normalizeAgentProviderError("cursor", "Internal Server Error");
    expect(normalizeAgentProviderError("cursor", once)).toEqual(once);
  });
});
