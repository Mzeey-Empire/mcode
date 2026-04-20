import { describe, it, expect } from "vitest";
import { AgentEventSchema, AgentEventType } from "../agent-event.js";

describe("AgentEvent provider_unavailable", () => {
  it("parses a disabled-provider event", () => {
    const parsed = AgentEventSchema().parse({
      type: "providerUnavailable",
      threadId: "t-1",
      providerId: "codex",
      reason: "disabled",
    });
    expect(parsed.type).toBe(AgentEventType.ProviderUnavailable);
  });

  it("parses a cli_missing event with configuredPath", () => {
    const parsed = AgentEventSchema().parse({
      type: "providerUnavailable",
      threadId: "t-1",
      providerId: "claude",
      reason: "cli_missing",
      configuredPath: "/custom/claude",
    });
    if (parsed.type !== "providerUnavailable") throw new Error("unreachable");
    expect(parsed.configuredPath).toBe("/custom/claude");
  });
});
