import { describe, it, expect } from "vitest";
import { WS_CHANNELS } from "../channels.js";

/**
 * Contract test for the `plan.answered` push channel. The web client and the
 * server both depend on this exact payload shape — keep it in sync with the
 * Zod schema definition in channels.ts.
 */
describe("WS_CHANNELS['plan.answered']", () => {
  it("accepts the canonical payload", () => {
    const result = WS_CHANNELS["plan.answered"].safeParse({
      threadId: "thread-1",
      assistantMessageId: "msg-42",
    });
    expect(result.success).toBe(true);
  });

  it("rejects payloads missing assistantMessageId", () => {
    const result = WS_CHANNELS["plan.answered"].safeParse({
      threadId: "thread-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects payloads missing threadId", () => {
    const result = WS_CHANNELS["plan.answered"].safeParse({
      assistantMessageId: "msg-42",
    });
    expect(result.success).toBe(false);
  });
});
