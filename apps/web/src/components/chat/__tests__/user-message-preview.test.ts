import { createMockMessage } from "@mcode/contracts/testing";
import { describe, expect, it } from "vitest";
import { PLAN_ANSWER_MESSAGE_PREFIX } from "@mcode/contracts";
import { resolveUserMessagePreview } from "../user-message-preview";

describe("resolveUserMessagePreview", () => {
  it("returns plain text for ordinary user messages", () => {
    expect(resolveUserMessagePreview(createMockMessage({ content: "Fix the scroll bug" }))).toBe(
      "Fix the scroll bug",
    );
  });

  it("strips markdown noise for sticky previews", () => {
    expect(resolveUserMessagePreview(createMockMessage({ content: "**Bold** and `code`" }))).toBe(
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
    expect(resolveUserMessagePreview(createMockMessage({ content }))).toBe(expected);
  });

  it.each([
    ["## Plan\n> quoted _note_", "Plan quoted note"],
    ["read [the docs](https://example.com/a_(b)) first", "read the docs first"],
    ["__bold__ and ~~gone~~", "bold and gone"],
  ])("drops markdown syntax in %j", (content, expected) => {
    expect(resolveUserMessagePreview(createMockMessage({ content }))).toBe(expected);
  });

  it("returns goal conditions for /goal set commands", () => {
    expect(resolveUserMessagePreview(createMockMessage({ content: "/goal ship sticky messages" }))).toBe(
      "ship sticky messages",
    );
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
    ).toBe("[Image attachment]");
  });

  it("labels code-only messages with the first code line", () => {
    expect(
      resolveUserMessagePreview(
        createMockMessage({ content: "```ts\nexport const sticky = true;\n```" }),
      ),
    ).toBe("[Code] export const sticky = true;");
  });
});
