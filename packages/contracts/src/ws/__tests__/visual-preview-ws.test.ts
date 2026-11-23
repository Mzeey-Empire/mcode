import { describe, expect, it } from "vitest";
import { WS_CHANNELS } from "../channels.js";
import { WS_METHODS } from "../methods.js";

const request = {
  requestId: "8ab6eb1f-97a8-4813-b3cf-37a89670b485",
  frameDocument: "<p>chart</p>",
  width: 420,
  maxHeight: 2000,
  deadlineMs: 15_000,
};

describe("visual preview transport", () => {
  it("rejects an oversized frame document", () => {
    const schema = WS_CHANNELS["visualPreview.request"];
    expect(schema.safeParse({ ...request, frameDocument: "x".repeat(576 * 1024) }).success).toBe(true);
    expect(schema.safeParse({ ...request, frameDocument: "x".repeat(576 * 1024 + 1) }).success).toBe(false);
  });

  it.each([239, 1601])("rejects preview width %d", (width) => {
    expect(WS_CHANNELS["visualPreview.request"].safeParse({ ...request, width }).success).toBe(false);
  });

  it("accepts a rendered capture with or without its PNG", () => {
    const schema = WS_METHODS()["visualPreview.host.respond"].params;
    const outcome = { kind: "rendered", contentHeight: 180, console: [], droppedConsoleEntries: 0 };
    expect(schema.safeParse({ requestId: request.requestId, outcome }).success).toBe(false);
    const withoutPng = { requestId: request.requestId, outcome: { ...outcome, heightStillChanging: true } };
    expect(schema.parse(withoutPng)).toEqual(withoutPng);
    const withPng = { requestId: request.requestId, outcome: { ...outcome, heightStillChanging: false, png: "cG5n" } };
    expect(schema.parse(withPng)).toEqual(withPng);
  });

  it.each([undefined, -1, 1.5])("rejects an invalid dropped console count (%s)", (droppedConsoleEntries) => {
    const schema = WS_METHODS()["visualPreview.host.respond"].params;
    expect(schema.safeParse({
      requestId: request.requestId,
      outcome: { kind: "rendered", contentHeight: 180, heightStillChanging: false, console: [], droppedConsoleEntries, png: "cG5n" },
    }).success).toBe(false);
  });

  it("accepts a busy reply from the desktop queue", () => {
    const schema = WS_METHODS()["visualPreview.host.respond"].params;
    const reply = { requestId: request.requestId, outcome: { kind: "failed", reason: "busy", message: "Queue wait expired" } };
    expect(schema.parse(reply)).toEqual(reply);
  });
});
