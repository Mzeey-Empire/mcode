import { describe, it, expect } from "vitest";
import { SendMessageSchema } from "../ws/methods.js";
import { MAX_ATTACHMENTS } from "../models/file-types.js";

const sampleAttachment = {
  id: "att-x",
  name: "note.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
  sourcePath: "/tmp/note.txt",
};

describe("SendMessageSchema attachments", () => {
  it(`allows up to ${MAX_ATTACHMENTS} attachments`, () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => ({
      ...sampleAttachment,
      id: `att-${i}`,
    }));
    const result = SendMessageSchema().safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: "hi",
      attachments,
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than MAX_ATTACHMENTS", () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({
      ...sampleAttachment,
      id: `att-${i}`,
    }));
    const result = SendMessageSchema().safeParse({
      threadId: "550e8400-e29b-41d4-a716-446655440000",
      content: "hi",
      attachments,
    });
    expect(result.success).toBe(false);
  });
});
