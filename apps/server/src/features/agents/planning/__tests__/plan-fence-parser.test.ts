import { describe, expect, it } from "vitest";
import { PlanFenceParser } from "@mcode/shared";

describe("PlanFenceParser", () => {
  const markdown = "# Plan\n\n## Build\n```ts\nconst answer = 42;\n```\nShip it.";
  const block = "Summary.\n````mcode-plan\n" + markdown + "\n````\nAfter.";

  it("preserves nested code fences at every chunk boundary", () => {
    for (let split = 0; split <= block.length; split++) {
      const parser = new PlanFenceParser();
      const results = [parser.feed(block.slice(0, split)), parser.feed(block.slice(split)), parser.finish()];
      expect(results.filter((result) => result !== null)).toEqual([markdown]);
    }
  });

  it("waits for a complete closing line and accepts a longer one at EOF", () => {
    const parser = new PlanFenceParser();
    expect(parser.feed("`````mcode-plan\n# Plan\n````\nStill inside\n``````")).toBeNull();
    expect(parser.finish()).toBe("# Plan\n````\nStill inside");
    expect(parser.finish()).toBeNull();
  });

  it.each([
    "````mcode-plan extra\n# Plan\n````",
    "prefix ````mcode-plan\n# Plan\n````",
    "````mcode-plan\n# Plan\n```` suffix",
    "````mcode-plan\n# Plan",
    "`````text\n````mcode-plan\n# Example\n````\n`````",
    "````mcode-plan\n \n````",
  ])("rejects non-plan or incomplete input: %s", (text) => {
    const parser = new PlanFenceParser();
    expect(parser.feed(text)).toBeNull();
    expect(parser.finish()).toBeNull();
  });

  it("preserves CRLF content and isolates speculative parser forks", () => {
    const parser = new PlanFenceParser();
    parser.feed("````mcode-plan\r\n# Plan\r\n");
    const fork = parser.fork();
    expect(fork.feed("Branch\r\n````\r\n")).toBe("# Plan\r\nBranch");
    expect(parser.feed("Original\r\n````\r\n")).toBe("# Plan\r\nOriginal");
  });

  it("captures a tilde plan fence, matching what the chat hides", () => {
    const parser = new PlanFenceParser();
    expect(parser.feed("~~~mcode-plan\n# Plan\n```sh\nls\n```\n~~~\n")).toBe("# Plan\n```sh\nls\n```");
  });

  it.each([3, 4, 5])("accepts a %i-backtick opener at every chunk boundary", (length) => {
    const fence = "`".repeat(length);
    const text = `${fence}mcode-plan\n# Plan\nShip it.\n${fence}`;
    for (let split = 0; split <= text.length; split++) {
      const parser = new PlanFenceParser();
      expect([parser.feed(text.slice(0, split)), parser.feed(text.slice(split)), parser.finish()]
        .filter((value) => value !== null)).toEqual(["# Plan\nShip it."]);
    }
  });
});
