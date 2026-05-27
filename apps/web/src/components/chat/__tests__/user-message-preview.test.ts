import { describe, expect, it } from "vitest";
import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts";
import type { Message } from "@/transport";
import { resolveUserMessagePreview, isStickyPreviewExpandable } from "../user-message-preview";

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    role: "user",
    content: "Hello there",
    timestamp: "2026-01-01T00:00:00.000Z",
    sequence: 1,
    attachments: null,
    cost_usd: null,
    tokens_used: null,
    ...overrides,
  };
}

describe("resolveUserMessagePreview", () => {
  it("returns plain text for ordinary user messages", () => {
    expect(resolveUserMessagePreview(userMessage({ content: "Fix the scroll bug" }))).toBe(
      "Fix the scroll bug",
    );
  });

  it("strips markdown noise for sticky previews", () => {
    expect(resolveUserMessagePreview(userMessage({ content: "**Bold** and `code`" }))).toBe(
      "Bold and code",
    );
  });

  it("returns goal conditions for /goal set commands", () => {
    expect(resolveUserMessagePreview(userMessage({ content: "/goal ship sticky messages" }))).toBe(
      "ship sticky messages",
    );
  });

  it("returns null for suppressed plan answer payloads", () => {
    expect(
      resolveUserMessagePreview(
        userMessage({ content: `${PLAN_ANSWER_MESSAGE_PREFIX} hidden payload` }),
      ),
    ).toBeNull();
  });

  it("summarizes attachment-only messages", () => {
    expect(
      resolveUserMessagePreview(
        userMessage({
          content: "",
          attachments: [{ id: "a1", name: "diagram.png", mimeType: "image/png", sizeBytes: 10 }],
        }),
      ),
    ).toBe("[Image attachment]");
  });

  it("labels code-only messages with the first code line", () => {
    expect(
      resolveUserMessagePreview(
        userMessage({ content: "```ts\nexport const sticky = true;\n```" }),
      ),
    ).toBe("[Code] export const sticky = true;");
  });

  it("marks long previews as expandable", () => {
    expect(isStickyPreviewExpandable("x".repeat(141))).toBe(true);
    expect(isStickyPreviewExpandable("short prompt")).toBe(false);
  });
});
