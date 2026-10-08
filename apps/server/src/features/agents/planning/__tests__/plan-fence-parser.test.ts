import { describe, expect, it } from "vitest";
import { PlanFenceParser } from "@mcode/shared";

const markdown = "# Plan\n\n## Step\n```ts\nconst answer = 42;\n```\nThen deploy.";
const block = "````mcode-plan\n" + markdown + "\n````";

describe("PlanFenceParser", () => {
  it("preserves nested triple-backtick code blocks", () => {
    const parser = new PlanFenceParser();
    parser.feed("Summary\n" + block);
    expect(parser.finish()).toBe(markdown);
  });

  it("handles every split across the opener, body and closer", () => {
    for (let split = 0; split <= block.length; split++) {
      const parser = new PlanFenceParser();
      parser.feed(block.slice(0, split));
      parser.feed(block.slice(split));
      expect(parser.finish()).toBe(markdown);
    }
  });

  it("handles one-character chunks and CRLF", () => {
    const parser = new PlanFenceParser();
    for (const character of block.replaceAll("\n", "\r\n")) parser.feed(character);
    expect(parser.finish()).toBe(markdown);
  });

  it("waits for a closing line, including its suffix, before accepting it", () => {
    const parser = new PlanFenceParser();
    expect(parser.feed("````mcode-plan\n# Plan\n````")).toBeNull();
    expect(parser.feed(" trailing text\nStill plan\n`````\n")).toBe("# Plan\n```` trailing text\nStill plan");
  });

  it.each([
    "# Plain prose\n## Headings",
    "```mcode-plan\n# Too short\n```",
    "````mcode-plan extra\n# Wrong info\n````",
    "````mcode-plan\n# Unclosed\n```",
    "`````mcode-plan\n# Short closer\n````",
    "````mcode-plan\n\n````",
    "`````markdown\n" + block + "\n`````",
  ])("rejects non-plan or incomplete fences: %s", (text) => {
    const parser = new PlanFenceParser();
    parser.feed(text);
    expect(parser.finish()).toBeNull();
  });
});
