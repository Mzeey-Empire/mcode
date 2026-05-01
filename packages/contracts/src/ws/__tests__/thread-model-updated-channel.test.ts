import { describe, it, expect } from "vitest";
import { WS_CHANNELS } from "../channels.js";

/**
 * Contract test for the `thread.modelUpdated` push channel. The web client
 * and the server both depend on this exact payload shape.
 */
describe("WS_CHANNELS['thread.modelUpdated']", () => {
  it("accepts the canonical payload", () => {
    const result = WS_CHANNELS["thread.modelUpdated"].safeParse({
      threadId: "thread-1",
      model: "gpt-5.4",
      provider: "codex",
    });
    expect(result.success).toBe(true);
  });

  it("accepts cursor as provider id", () => {
    const result = WS_CHANNELS["thread.modelUpdated"].safeParse({
      threadId: "thread-1",
      model: "any-model",
      provider: "cursor",
    });
    expect(result.success).toBe(true);
  });

  it("rejects payloads missing model", () => {
    const result = WS_CHANNELS["thread.modelUpdated"].safeParse({
      threadId: "thread-1",
      provider: "claude",
    });
    expect(result.success).toBe(false);
  });
});
