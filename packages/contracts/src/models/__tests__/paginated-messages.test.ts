import { describe, it, expect } from "vitest";
import { PaginatedMessagesSchema } from "../message.js";

/**
 * The `message.list` response gains `answeredPlanMessageIds` so the web client
 * can hydrate plan-question wizard state in one round-trip without falling
 * back to the structural heuristic.
 */
describe("PaginatedMessagesSchema", () => {
  it("validates a response with answeredPlanMessageIds", () => {
    const ok = PaginatedMessagesSchema().safeParse({
      messages: [],
      hasMore: false,
      answeredPlanMessageIds: ["msg-1", "msg-2"],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.answeredPlanMessageIds).toEqual(["msg-1", "msg-2"]);
    }
  });

  it("treats answeredPlanMessageIds as optional for backwards compatibility", () => {
    const ok = PaginatedMessagesSchema().safeParse({
      messages: [],
      hasMore: false,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a non-string-array for answeredPlanMessageIds", () => {
    const bad = PaginatedMessagesSchema().safeParse({
      messages: [],
      hasMore: false,
      answeredPlanMessageIds: [123],
    });
    expect(bad.success).toBe(false);
  });
});
