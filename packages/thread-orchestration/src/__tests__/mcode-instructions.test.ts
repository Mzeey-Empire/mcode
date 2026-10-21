import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildMcodeInstructionSections,
  MCODE_INSTRUCTION_SECTION_MAX_BYTES,
  renderMcodeInstructionSections,
} from "../index.js";

const toolkitCombinations = [
  { threadControl: false, browser: false },
  { threadControl: false, browser: true },
  { threadControl: true, browser: false },
  { threadControl: true, browser: true },
];

describe("Mcode runtime instruction sections", () => {
  it.each(toolkitCombinations)("selects guidance for attached toolkits: %j", (toolkits) => {
    const sections = buildMcodeInstructionSections({ toolkits });
    const keys = sections.map((section) => section.key);
    expect(keys.includes("mcode_browser")).toBe(toolkits.browser);
    expect(keys.includes("mcode_thread_control")).toBe(toolkits.threadControl);
    expect(keys).toEqual([
      "mcode_identity",
      "mcode_provider_subagents",
      ...(toolkits.threadControl ? ["mcode_thread_control"] : []),
      ...(toolkits.browser ? ["mcode_browser"] : []),
      "mcode_repository_search",
    ]);
  });

  it.each(toolkitCombinations)("retains repository search with a long nested model: %j", (toolkits) => {
    const sections = buildMcodeInstructionSections({ toolkits, nestedDelegationModel: "m".repeat(3_000) });
    expect(sections.at(-1)).toEqual({
      key: "mcode_repository_search",
      text: "For broad repository searches, first list files with rg -l. Exclude fixtures and captured traces (*.ndjson) unless the task targets them, and bound line output with rg --max-columns 240 before reading matches.",
    });
  });

  for (const nestedDelegationModel of [undefined, "模型".repeat(500)]) {
    it.each(toolkitCombinations)(
      "keeps each section within the UTF-8 context budget with unique tag keys: %j",
      (toolkits) => {
        const sections = buildMcodeInstructionSections({ toolkits, nestedDelegationModel });
        for (const section of sections) {
          expect(NodeBuffer.Buffer.byteLength(section.text, "utf8")).toBeLessThanOrEqual(MCODE_INSTRUCTION_SECTION_MAX_BYTES);
          expect(section.key).toMatch(/^[a-z][a-z0-9_]*$/);
        }
        const keys = sections.map((section) => section.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toContain("mcode_repository_search");
        expect(keys.includes("mcode_nested_delegation")).toBe(nestedDelegationModel !== undefined);
      },
    );
  }

  it("trims nested models and omits a blank model", () => {
    const toolkits = { threadControl: false, browser: false };
    const sections = buildMcodeInstructionSections({ toolkits, nestedDelegationModel: "  gpt-5.6-sol  " });
    expect(sections.map((section) => section.key)).toEqual([
      "mcode_identity", "mcode_provider_subagents", "mcode_nested_delegation", "mcode_repository_search",
    ]);
    expect(sections[2]?.text).toContain('"gpt-5.6-sol"');
    expect(buildMcodeInstructionSections({ toolkits, nestedDelegationModel: "  " }).map((section) => section.key))
      .not.toContain("mcode_nested_delegation");
  });

  it("renders complete sections in order for native single-field delivery", () => {
    const sections = buildMcodeInstructionSections({ toolkits: { threadControl: false, browser: false } });
    expect(renderMcodeInstructionSections(sections)).toBe(
      "You are operating inside an Mcode-managed session. Mcode runtime guidance is advisory; MCP authorization and lease state remain authoritative.\n\n"
      + "A child-agent or sub-agent request uses provider-native collaboration in the current turn. Use collaboration tools, preserve the exact requested brief, and keep direct and nested parent relationships intact. A child-agent request does not authorize Mcode thread control; use thread tools only for an explicit Mcode thread request.\n\n"
      + "For broad repository searches, first list files with rg -l. Exclude fixtures and captured traces (*.ndjson) unless the task targets them, and bound line output with rg --max-columns 240 before reading matches.",
    );
  });
});
