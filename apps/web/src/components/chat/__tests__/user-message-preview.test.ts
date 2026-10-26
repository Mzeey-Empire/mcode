import { describe, expect, it } from "vitest";
import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts";
import type { Message } from "@/transport";
import { resolveUserMessagePreview } from "../user-message-preview";

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

  it.each([
    ["call thread_target_list then delegate_task", "call thread_target_list then delegate_task"],
    ["see `src/__tests__/a_b.ts`", "see src/__tests__/a_b.ts"],
    ["open https://example.com/wiki/Foo_(bar)", "open https://example.com/wiki/Foo_(bar)"],
    ["fix issue #2269 when a > b and [x] is set", "fix issue #2269 when a > b and [x] is set"],
    ["2 * 3 * 4 = 24", "2 * 3 * 4 = 24"],
  ])("keeps literal characters in %j", (content, expected) => {
    expect(resolveUserMessagePreview(userMessage({ content }))).toBe(expected);
  });

  it.each([
    ["## Plan\n> quoted _note_", "Plan quoted note"],
    ["read [the docs](https://example.com/a_(b)) first", "read the docs first"],
    ["__bold__ and ~~gone~~", "bold and gone"],
  ])("drops markdown syntax in %j", (content, expected) => {
    expect(resolveUserMessagePreview(userMessage({ content }))).toBe(expected);
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
});
