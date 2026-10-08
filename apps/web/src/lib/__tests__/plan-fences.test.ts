import { describe, expect, it } from "vitest";
import { stripPlanFences } from "../plan-fences";

describe("stripPlanFences", () => {
  it("hides historic JSON without parsing it", () => {
    expect(stripPlanFences('Summary.\n```plan-output\n{invalid JSON}\n```\nAfter.')).toBe("Summary.\nAfter.");
    expect(stripPlanFences('```plan-output\n{}\n```')).toBe("");
    expect(stripPlanFences('```plan-questions\n[]\n```')).toBe("");
  });

  it("hides the full plan while its nested code block streams", () => {
    const start = "Summary.\n````mcode-plan\n";
    const rest = "# Secret plan\n```ts\nconst value = 1;\n```\n````";
    for (let length = 0; length <= rest.length; length++) {
      expect(stripPlanFences(start + rest.slice(0, length))).toBe("Summary.\n");
    }
  });

  it("matches exact info strings and keeps example fences intact", () => {
    const examples = [
      "````mcode-plan-example\nVisible\n````",
      "```plan-output extra\nVisible\n```",
      "`````text\n````mcode-plan\nExample\n````\n`````",
      "Inline `mcode-plan` stays.",
    ];
    for (const text of examples) {
      expect(stripPlanFences(text)).toBe(text);
      expect(stripPlanFences(text, true)).toBe(text);
    }
  });

  it("requires a matching closing marker and fence length", () => {
    expect(stripPlanFences("Before\r\n`````mcode-plan\r\n# Hidden\r\n````\r\nMore\r\n``````\r\nAfter")).toBe("Before\r\nAfter");
  });
});
