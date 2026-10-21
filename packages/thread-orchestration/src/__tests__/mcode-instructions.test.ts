import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildMcodeInstructionSections,
  isExplicitMcodeThreadRequest,
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
  it.each([
    "Spawn exactly one nested provider-native child named leaf_probe",
    "Delegate this task to a provider-native subagent",
  ])("does not grant Mcode thread control to provider-native child wording: %s", (request) => {
    expect(isExplicitMcodeThreadRequest(request)).toBe(false);
  });

  it.each([
    "Create one Mcode thread named leaf_probe",
    "Use thread_create_batch for the requested Mcode thread",
    "Use the mcode delegate_task tool to hand this to Claude",
    "Call task_status for the delegated task",
    "Cancel it with task_cancel",
  ])("recognizes explicit Mcode thread requests: %s", (request) => {
    expect(isExplicitMcodeThreadRequest(request)).toBe(true);
  });

  it.each([
    "Call delegate_task exactly once to hand this review to Codex. Do not call any other tool, and report what delegate_task returned.",
    "Delegate this with delegate_task. Don't wait on it, check task_status later.",
    "Use delegate_task for the review and never poll it in a loop.",
  ])("grants an explicit request that also contains an unrelated negation: %s", (request) => {
    expect(isExplicitMcodeThreadRequest(request)).toBe(true);
  });

  it.each([
    "Do not create an Mcode thread",
    "Don't use delegate_task, just fix the bug.",
    "Do not, under any circumstances, call delegate_task.",
    "Without creating an Mcode thread, fix the bug and check the status.",
    "Fix the bug.\nNever use delegate_task or task_status here.",
    "Don't edit src/a.ts or call delegate_task.",
    "Do not bump Node to 20.1 or use delegate_task.",
    "Never do any of these:\n- call delegate_task\n- check task_status",
    "Don't wait; call delegate_task.",
  ])("fails closed when every thread-control mention is negated: %s", (request) => {
    expect(isExplicitMcodeThreadRequest(request)).toBe(false);
  });

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
