import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { stripPlanFences } from "../plan-fences";

describe("plan fences", () => {
  it("renders historic prose without the JSON fence", () => {
    const content = 'Summary for you.\n\n```plan-output\n{"title":"hidden-json"}\n```';
    expect(stripPlanFences(content)).toBe("Summary for you.\n\n");
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content }));
    expect(html).toContain("Summary for you.");
    expect(html).not.toContain("hidden-json");
  });

  it("never renders any prefix of a streamed plan, including nested code", () => {
    const fence = "````mcode-plan\n# Hidden plan\n```ts\nsecretCode();\n```\n````";
    for (let end = 1; end <= fence.length; end++) {
      const content = "Summary.\n\n" + fence.slice(0, end);
      expect(stripPlanFences(content, true)).toBe("Summary.\n\n");
      const rendered = document.createElement("div");
      rendered.innerHTML = renderToStaticMarkup(createElement(MarkdownContent, { content, isStreaming: true }));
      expect(rendered.textContent).toBe("Summary.");
    }
  });

  it.each(["plan-questions", "mcode-plan", "plan-output"])("hides the exact %s info string without reading its content", (info) => {
    expect(stripPlanFences("````" + info + "\nNot JSON\n````")).toBe("");
    expect(stripPlanFences("````" + info + "\nUnclosed")).toBe("");
    const ordinary = "````" + info + " extra\nVisible code\n````";
    expect(stripPlanFences(ordinary)).toBe(ordinary);
    expect(renderToStaticMarkup(createElement(MarkdownContent, { content: ordinary }))).toContain("Visible code");
  });

  it("keeps literal examples inside ordinary fences and prose after a longer closer", () => {
    const example = "`````markdown\n````mcode-plan\nExample\n````\n`````";
    expect(stripPlanFences(example)).toBe(example);
    expect(stripPlanFences("Before\r\n````mcode-plan\r\n# Hidden\r\n```\r\nStill hidden\r\n`````\r\nAfter")).toBe("Before\r\nAfter");
  });
});
