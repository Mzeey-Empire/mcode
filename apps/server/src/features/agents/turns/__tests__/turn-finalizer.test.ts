import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openWorkerTurnFixture } from "../../orchestration/__tests__/worker-turn-fixture.js";

describe("worker-owned terminal persistence", () => {
  let fixture: Awaited<ReturnType<typeof openWorkerTurnFixture>>;
  beforeEach(async () => { fixture = await openWorkerTurnFixture(); });
  afterEach(async () => { await fixture?.close(); });

  it("materializes the buffered provider body into exactly one assistant row", async () => {
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: "Saved answer", tokens: null });
    await fixture.finish();
    expect(fixture.messages.listByThread(fixture.thread.id, 10).messages.filter((message) => message.role === "assistant"))
      .toEqual([expect.objectContaining({ content: "Saved answer", provider: "codex", outcome: "completed" })]);
  });

  it("materializes an image-only assistant row for generated attachments", async () => {
    await fixture.emit({
      type: "generatedAttachment", threadId: fixture.thread.id,
      attachment: { id: "image-1", name: "image.png", mimeType: "image/png", sizeBytes: 4 },
    });
    await fixture.finish();
    expect(fixture.assistant()).toMatchObject({
      content: "", outcome: "completed",
      attachments: [{ id: "image-1", name: "image.png", mimeType: "image/png", sizeBytes: 4 }],
    });
  });

  it("leaves no assistant row for a fully empty turn", async () => {
    await fixture.finish();
    expect(fixture.messages.listByThread(fixture.thread.id, 10).messages.map((message) => message.role)).toEqual(["user"]);
    expect(fixture.db.query("SELECT status FROM canonical_agent_turns WHERE id = ?").get(fixture.turn.turnId))
      .toEqual({ status: "Completed" });
  });

  it("materializes an assistant row for a tool call when no Message event fired", async () => {
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "read-1", toolName: "Read", toolInput: {} });
    await fixture.emit({ type: "error", threadId: fixture.thread.id, error: "Provider failed", failure: { kind: "fatal" } });
    const assistant = fixture.assistant();
    expect(assistant).toMatchObject({ content: "", outcome: "errored" });
    expect(fixture.tools.listByMessage(assistant!.id)).toEqual([
      expect.objectContaining({ id: "read-1", tool_name: "Read", status: "failed" }),
    ]);
  });

  it.each([
    ["completed", "completed"], ["errored", "failed"], ["cancelled", "cancelled"],
  ] as const)("persists the %s outcome and its tool status", async (outcome, status) => {
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "Partial answer", isFinalResponse: true });
    await fixture.emit({ type: "toolUse", threadId: fixture.thread.id, toolCallId: "tool-1", toolName: "Bash", toolInput: { command: "work" } });
    if (outcome === "completed") await fixture.finish();
    else if (outcome === "cancelled") await fixture.stop();
    else await fixture.emit({ type: "error", threadId: fixture.thread.id, error: "Provider failed", failure: { kind: "fatal" } });
    const assistant = fixture.assistant();
    expect(assistant).toMatchObject({ content: "Partial answer", outcome });
    expect(fixture.tools.listByMessage(assistant!.id)).toEqual([
      expect.objectContaining({ id: "tool-1", status }),
    ]);
  });

  it("keeps a published assistant identity when a later notice changes the last row", async () => {
    await fixture.emit({ type: "message", threadId: fixture.thread.id, content: "Answer", tokens: null });
    const message = fixture.published.find((event) => event.type === "message");
    if (message?.type !== "message") throw new Error("No public assistant message");
    await fixture.emit({
      type: "system", threadId: fixture.thread.id, subtype: "provider.notice.warning", message: "Later notice",
      systemNotice: { kind: "diagnostic", presentation: "timeline", scope: "session", sessionId: "notice-session" },
    });
    await fixture.finish();
    expect(fixture.assistant()).toMatchObject({ id: message.messageId, content: "Answer", outcome: "completed" });
    expect(fixture.messages.listByThread(fixture.thread.id, 10).messages.filter((row) => row.role === "assistant")).toHaveLength(1);
  });

  it("flushes interrupted streaming text into a new assistant row", async () => {
    await fixture.emit({ type: "textDelta", threadId: fixture.thread.id, delta: "Interrupted answer", isFinalResponse: true });
    await fixture.stop();
    expect(fixture.assistant()).toMatchObject({ content: "Interrupted answer", provider: "codex", outcome: "cancelled" });
  });
});
