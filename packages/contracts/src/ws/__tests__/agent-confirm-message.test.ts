import { describe, expect, it } from "vitest";
import { WS_METHODS } from "../methods.js";

const messageId = "00000000-0000-4000-8000-000000000001";
const method = WS_METHODS()["agent.confirmMessage"];

describe("agent.confirmMessage contract", () => {
  it("accepts a nonempty thread id and a UUID message id", () => {
    expect(method.params.parse({ threadId: "thread-1", messageId })).toEqual({ threadId: "thread-1", messageId });
  });

  it.each([
    {},
    { threadId: "thread-1" },
    { messageId },
    { threadId: "", messageId },
    { threadId: 1, messageId },
    { threadId: "thread-1", messageId: "not-a-uuid" },
    { threadId: "thread-1", messageId: "" },
    { threadId: "thread-1", messageId, extra: true },
  ])("rejects malformed params %j", (params) => {
    expect(method.params.safeParse(params).success).toBe(false);
  });

  it.each([true, false])("accepts admitted: %s", (admitted) => {
    expect(method.result.parse({ admitted })).toEqual({ admitted });
  });

  it.each([{}, { admitted: "false" }, { admitted: false, extra: true }])("rejects malformed results %j", (result) => {
    expect(method.result.safeParse(result).success).toBe(false);
  });
});
