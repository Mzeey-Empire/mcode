import { createMockMessage } from "@mcode/contracts/testing";
import { describe, expect, it } from "vitest";
import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts/models/plan-questions";
import { resolveUserMessagePreview } from "../user-message-preview";

const plain = (text: string) => ({ kind: "plain", text });

const architectMention = {
  id: "command:skill:architect",
  kind: "command",
  label: "architect",
  namespace: "skill",
  range: { start: 0, end: 10 },
} as const;

describe("resolveUserMessagePreview", () => {
  it("returns plain text for ordinary user messages", () => {
    expect(resolveUserMessagePreview(createMockMessage({ content: "Fix the scroll bug" }))).toEqual(plain("Fix the scroll bug"));
  });

  it("strips markdown noise for sticky previews", () => {
    expect(resolveUserMessagePreview(createMockMessage({ content: "**Bold** and `code`" }))).toEqual(plain("Bold and code"));
  });

  it.each([
    ["call thread_target_list then delegate_task", "call thread_target_list then delegate_task"],
    ["see `src/__tests__/a_b.ts`", "see src/__tests__/a_b.ts"],
    ["open https://example.com/wiki/Foo_(bar)", "open https://example.com/wiki/Foo_(bar)"],
    ["fix issue #2269 when a > b and [x] is set", "fix issue #2269 when a > b and [x] is set"],
    ["2 * 3 * 4 = 24", "2 * 3 * 4 = 24"],
  ])("keeps literal characters in %j", (content, expected) => {
    expect(resolveUserMessagePreview(createMockMessage({ content }))).toEqual(plain(expected));
  });

  it.each([
    ["## Plan\n> quoted _note_", "Plan quoted note"],
    ["read [the docs](https://example.com/a_(b)) first", "read the docs first"],
    ["__bold__ and ~~gone~~", "bold and gone"],
  ])("drops markdown syntax in %j", (content, expected) => {
    expect(resolveUserMessagePreview(createMockMessage({ content }))).toEqual(plain(expected));
  });

  it("returns goal conditions for /goal set commands", () => {
    expect(resolveUserMessagePreview(createMockMessage({ content: "/goal ship sticky messages" }))).toEqual(plain("ship sticky messages"));
  });

  it("returns null for suppressed plan answer payloads", () => {
    expect(
      resolveUserMessagePreview(
        createMockMessage({ content: `${PLAN_ANSWER_MESSAGE_PREFIX} hidden payload`, attachments: null }),
      ),
    ).toBeNull();
  });

  it("summarizes attachment-only messages", () => {
    expect(
      resolveUserMessagePreview(
        createMockMessage({
          content: "",
          attachments: [{ id: "a1", name: "diagram.png", mimeType: "image/png", sizeBytes: 10 }],
        }),
      ),
    ).toEqual(plain("[Image attachment]"));
  });

  it("labels code-only messages with the first code line", () => {
    expect(
      resolveUserMessagePreview(
        createMockMessage({ content: "```ts\nexport const sticky = true;\n```" }),
      ),
    ).toEqual(plain("[Code] export const sticky = true;"));
  });

  it("keeps mentions and the raw text so the sticky bar can render tokens", () => {
    const content = "/architect  sketch the **API**";
    expect(
      resolveUserMessagePreview(createMockMessage({ content, mentions: [architectMention] })),
    ).toEqual({ kind: "mentions", text: content, mentions: [architectMention] });
  });

  it("previews /goal commands as plain text even when they carry mentions", () => {
    expect(
      resolveUserMessagePreview(
        createMockMessage({ content: "/goal ship /architect", mentions: [{ ...architectMention, range: { start: 11, end: 21 } }] }),
      ),
    ).toEqual(plain("ship /architect"));
  });
});
