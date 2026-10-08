import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { stripPlanFences } from "../plan-fences";
import { PlanFenceParser } from "@mcode/shared";

describe("plan fences", () => {
  it("renders historic prose without the JSON fence", () => {
    const content = 'Summary for you.\n\n```plan-output\n{"title":"hidden-json"}\n```';
    expect(stripPlanFences(content)).toBe("Summary for you.\n\n");
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content }));
    expect(html).toContain("Summary for you.");
    expect(html).not.toContain("hidden-json");
  });

  it.each(["````", "~~~~"])("never renders any prefix of a streamed %s plan, including nested code", (marker) => {
    const fence = marker + "mcode-plan\n# Hidden plan\n```ts\nsecretCode();\n```\n" + marker;
    for (let end = 1; end <= fence.length; end++) {
      const content = "Summary.\n\n" + fence.slice(0, end);
      expect(stripPlanFences(content, true)).toBe("Summary.\n\n");
      const rendered = document.createElement("div");
      rendered.innerHTML = renderToStaticMarkup(createElement(MarkdownContent, { content: stripPlanFences(content, true), isStreaming: true }));
      expect(rendered.textContent).toBe("Summary.");
    }
  });

  it.each(["plan-questions", "mcode-plan", "plan-output"])("hides the exact %s info string without reading its content", (info) => {
    expect(stripPlanFences("````" + info + "\nNot JSON\n````")).toBe("");
    expect(stripPlanFences("````" + info + "\nUnclosed")).toBe("");
    const ordinary = "````" + info + "-example\nVisible code\n````";
    expect(stripPlanFences(ordinary)).toBe(ordinary);
    expect(renderToStaticMarkup(createElement(MarkdownContent, { content: ordinary }))).toContain("Visible code");
  });

  it.each(["```", "````", "~~~~", "~~~"])("hides exactly the mcode-plan openers that capture: %s", (marker) => {
    const content = marker + "mcode-plan\n# Plan\n" + marker;
    const parser = new PlanFenceParser();
    parser.feed(content);
    expect(parser.finish()).toBe("# Plan");
    expect(stripPlanFences(content)).toBe("");
  });

  it.each(["plan-output", "plan-questions json"])("hides nested historic %s blocks", (info) => {
    const content = `Summary\n\n> \`\`\`${info}\n> hidden-json\n> \`\`\`\n\n- item\n\n  \`\`\`${info}\n  hidden-list-json\n  \`\`\``;
    const html = renderToStaticMarkup(createElement(MarkdownContent, { content }));
    expect(html).toContain("Summary");
    expect(html).toContain("item");
    expect(html).not.toContain("hidden-json");
    expect(html).not.toContain("hidden-list-json");
  });

  it("keeps a non-protocol info string and unfinished ordinary Markdown visible outside chat", () => {
    const content = "```mcode-plan-example\nVisible\n```";
    expect(stripPlanFences(content)).toBe(content);
    expect(renderToStaticMarkup(createElement(MarkdownContent, { content }))).toContain("Visible");
    expect(renderToStaticMarkup(createElement(MarkdownContent, { content: "```mcode-pl", isStreaming: true }))).toContain("mcode-pl");
    const metadata = "```mcode-plan extra\nVisible metadata\n```";
    expect(stripPlanFences(metadata)).toBe(metadata);
    expect(renderToStaticMarkup(createElement(MarkdownContent, { content: metadata }))).toContain("Visible metadata");
  });

  it("keeps literal examples inside ordinary fences and prose after a longer closer", () => {
    const example = "`````markdown\n````mcode-plan\nExample\n````\n`````";
    expect(stripPlanFences(example)).toBe(example);
    expect(stripPlanFences("Before\r\n````mcode-plan\r\n# Hidden\r\n```\r\nStill hidden\r\n`````\r\nAfter")).toBe("Before\r\nAfter");
  });
});
