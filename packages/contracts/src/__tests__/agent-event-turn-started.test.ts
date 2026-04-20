import { describe, it, expect } from "vitest";
import { AgentEventSchema, AgentEventType } from "../events/agent-event.js";

describe("AgentEventType.TurnStarted", () => {
  it("is exported as a string discriminant", () => {
    expect(AgentEventType.TurnStarted).toBe("turnStarted");
  });

  it("round-trips through AgentEventSchema", () => {
    const event = { type: "turnStarted", threadId: "t-1" };
    const parsed = AgentEventSchema().parse(event);
    expect(parsed).toEqual(event);
  });

  it("rejects a turnStarted event missing threadId", () => {
    const bad = { type: "turnStarted" };
    expect(() => AgentEventSchema().parse(bad)).toThrow();
  });
});
