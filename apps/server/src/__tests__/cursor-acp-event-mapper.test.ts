import { describe, it, expect } from "vitest";
import {
  mapCursorAcpNotification,
  type CursorStreamAccumulator,
} from "../providers/cursor/cursor-acp-event-mapper.js";

function freshAcc(): CursorStreamAccumulator {
  return { assistantText: "", toolStartTimes: new Map() };
}

describe("mapCursorAcpNotification", () => {
  it("emits TextDelta for agent_message_chunk", () => {
    const acc = freshAcc();
    const events = mapCursorAcpNotification(
      {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "hello" },
          },
        },
      },
      "t1",
      acc,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "textDelta", delta: "hello" });
    expect(acc.assistantText).toBe("hello");
  });

  it("returns empty for non-session/update methods", () => {
    const events = mapCursorAcpNotification(
      { method: "other/thing", params: {} },
      "t1",
      freshAcc(),
    );
    expect(events).toEqual([]);
  });

  it("returns empty for unknown sessionUpdate types (no crash)", () => {
    const events = mapCursorAcpNotification(
      {
        method: "session/update",
        params: { update: { sessionUpdate: "some_unknown_type" } },
      },
      "t1",
      freshAcc(),
    );
    expect(events).toEqual([]);
  });
});
